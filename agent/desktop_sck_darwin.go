//go:build darwin

package main

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

// Przechwytywanie ekranu macOS przez ScreenCaptureKit (macOS 12.3+): ciągły strumień (SCStream),
// skalowanie do rozdzielczości punktowej po stronie karty graficznej, klatki tylko przy zmianach.
// Starsze CGDisplayCreateImage na nowym macOS przy każdym wywołaniu pyta użytkownika o zgodę
// („pominięcie systemowego wyboru okna”) — zostaje tylko jako zapas dla starych systemów.

var (
	sckOnce sync.Once
	sckErr  error

	cmSampleBufferGetImageBuffer   func(sb uintptr) uintptr
	cvPixelBufferLockBaseAddress   func(pb uintptr, flags uint64) int32
	cvPixelBufferUnlockBaseAddress func(pb uintptr, flags uint64) int32
	cvPixelBufferGetBaseAddress    func(pb uintptr) *byte
	cvPixelBufferGetBytesPerRow    func(pb uintptr) uintptr
	cvPixelBufferGetWidth          func(pb uintptr) uintptr
	cvPixelBufferGetHeight         func(pb uintptr) uintptr
	dispatchQueueCreate            func(label *byte, attr uintptr) uintptr

	sckOutputClass objc.Class
	sckQueue       uintptr
	sckQueueLabel  = []byte("pl.overmedia.overvnc.capture\x00")
	// strumień, do którego trafiają klatki (pomocnik przechwytuje jeden monitor naraz)
	sckActive atomic.Pointer[sckStream]
)

func sel(name string) objc.SEL { return objc.RegisterName(name) }

func loadSCK() error {
	sckOnce.Do(func() {
		for _, lib := range []string{
			"/System/Library/Frameworks/ScreenCaptureKit.framework/ScreenCaptureKit",
			"/System/Library/Frameworks/CoreMedia.framework/CoreMedia",
			"/System/Library/Frameworks/CoreVideo.framework/CoreVideo",
		} {
			if _, err := purego.Dlopen(lib, purego.RTLD_NOW|purego.RTLD_GLOBAL); err != nil {
				sckErr = err
				return
			}
		}
		if objc.GetClass("SCStream") == 0 {
			sckErr = errors.New("ScreenCaptureKit niedostępny (macOS starszy niż 12.3)")
			return
		}
		defer func() {
			if r := recover(); r != nil {
				sckErr = fmt.Errorf("ScreenCaptureKit: %v", r)
			}
		}()
		cm, _ := purego.Dlopen("/System/Library/Frameworks/CoreMedia.framework/CoreMedia", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		cv, _ := purego.Dlopen("/System/Library/Frameworks/CoreVideo.framework/CoreVideo", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		sys, err := purego.Dlopen("/usr/lib/libSystem.B.dylib", purego.RTLD_NOW|purego.RTLD_GLOBAL)
		if err != nil {
			sckErr = err
			return
		}
		purego.RegisterLibFunc(&cmSampleBufferGetImageBuffer, cm, "CMSampleBufferGetImageBuffer")
		purego.RegisterLibFunc(&cvPixelBufferLockBaseAddress, cv, "CVPixelBufferLockBaseAddress")
		purego.RegisterLibFunc(&cvPixelBufferUnlockBaseAddress, cv, "CVPixelBufferUnlockBaseAddress")
		purego.RegisterLibFunc(&cvPixelBufferGetBaseAddress, cv, "CVPixelBufferGetBaseAddress")
		purego.RegisterLibFunc(&cvPixelBufferGetBytesPerRow, cv, "CVPixelBufferGetBytesPerRow")
		purego.RegisterLibFunc(&cvPixelBufferGetWidth, cv, "CVPixelBufferGetWidth")
		purego.RegisterLibFunc(&cvPixelBufferGetHeight, cv, "CVPixelBufferGetHeight")
		purego.RegisterLibFunc(&dispatchQueueCreate, sys, "dispatch_queue_create")

		var protocols []*objc.Protocol
		if p := objc.GetProtocol("SCStreamOutput"); p != nil {
			protocols = append(protocols, p)
		}
		sckOutputClass, sckErr = objc.RegisterClass("OVNCStreamOutput", objc.GetClass("NSObject"), protocols, nil, []objc.MethodDef{{
			Cmd: sel("stream:didOutputSampleBuffer:ofType:"),
			Fn: func(_ objc.ID, _ objc.SEL, _ objc.ID, sb uintptr, typ int) {
				if typ != 0 { // 0 = SCStreamOutputTypeScreen
					return
				}
				if s := sckActive.Load(); s != nil {
					s.onSample(sb)
				}
			},
		}})
		if sckErr != nil {
			return
		}
		sckQueue = dispatchQueueCreate(&sckQueueLabel[0], 0)
	})
	return sckErr
}

type cmTime struct {
	Value     int64
	Timescale int32
	Flags     uint32
	Epoch     int64
}

// sckStream — strumień jednego monitora; ostatnia klatka trzymana do odczytu przez capture().
type sckStream struct {
	display uint32
	w, h    int
	stream  objc.ID
	output  objc.ID

	mu    sync.Mutex
	front []byte
	seq   uint64
}

func nsErrorText(e objc.ID) string {
	if e == 0 {
		return ""
	}
	desc := e.Send(sel("localizedDescription"))
	if desc == 0 {
		return "nieznany błąd"
	}
	p := objc.Send[*byte](desc, sel("UTF8String"))
	if p == nil {
		return "nieznany błąd"
	}
	n := 0
	for *(*byte)(unsafe.Add(unsafe.Pointer(p), n)) != 0 && n < 1000 {
		n++
	}
	return string(unsafe.Slice(p, n))
}

// startSCK uruchamia strumień monitora w rozmiarze w×h (punkty) — macOS skaluje obraz sam.
func startSCK(display uint32, w, h int) (*sckStream, error) {
	if err := loadSCK(); err != nil {
		return nil, err
	}
	// lista ekranów (asynchronicznie, z blokiem zwrotnym)
	type res struct{ content, err objc.ID }
	ch := make(chan res, 1)
	blk := objc.NewBlock(func(_ objc.Block, content objc.ID, e objc.ID) {
		if content != 0 {
			content.Send(sel("retain"))
		}
		ch <- res{content, e}
	})
	objc.ID(objc.GetClass("SCShareableContent")).Send(sel("getShareableContentWithCompletionHandler:"), blk)
	var r res
	select {
	case r = <-ch:
	case <-time.After(10 * time.Second):
		return nil, errors.New("ScreenCaptureKit nie odpowiada")
	}
	if r.content == 0 {
		return nil, fmt.Errorf("lista ekranów: %s", nsErrorText(r.err))
	}
	defer r.content.Send(sel("release"))

	displays := r.content.Send(sel("displays"))
	var scDisplay objc.ID
	for i := range objc.Send[uint](displays, sel("count")) {
		d := displays.Send(sel("objectAtIndex:"), i)
		if objc.Send[uint32](d, sel("displayID")) == display {
			scDisplay = d
			break
		}
	}
	if scDisplay == 0 {
		return nil, errors.New("monitor niedostępny dla ScreenCaptureKit")
	}

	empty := objc.ID(objc.GetClass("NSArray")).Send(sel("array"))
	filter := objc.ID(objc.GetClass("SCContentFilter")).Send(sel("alloc")).Send(sel("initWithDisplay:excludingWindows:"), scDisplay, empty)
	cfg := objc.ID(objc.GetClass("SCStreamConfiguration")).Send(sel("new"))
	cfg.Send(sel("setWidth:"), uint(w))
	cfg.Send(sel("setHeight:"), uint(h))
	cfg.Send(sel("setPixelFormat:"), uint32(0x42475241)) // 'BGRA'
	cfg.Send(sel("setShowsCursor:"), false)              // kursor rysuje przeglądarka albo my
	cfg.Send(sel("setQueueDepth:"), 3)
	cfg.Send(sel("setMinimumFrameInterval:"), cmTime{Value: 1, Timescale: 30, Flags: 1}) // najwyżej 30 kl./s

	s := &sckStream{display: display, w: w, h: h}
	s.stream = objc.ID(objc.GetClass("SCStream")).Send(sel("alloc")).Send(sel("initWithFilter:configuration:delegate:"), filter, cfg, objc.ID(0))
	if s.stream == 0 {
		return nil, errors.New("nie można utworzyć strumienia ekranu")
	}
	s.output = objc.ID(sckOutputClass).Send(sel("new"))
	var addErr objc.ID
	if !objc.Send[bool](s.stream, sel("addStreamOutput:type:sampleHandlerQueue:error:"), s.output, 0, sckQueue, unsafe.Pointer(&addErr)) {
		return nil, fmt.Errorf("strumień ekranu: %s", nsErrorText(addErr))
	}
	sckActive.Store(s)
	done := make(chan objc.ID, 1)
	startBlk := objc.NewBlock(func(_ objc.Block, e objc.ID) { done <- e })
	s.stream.Send(sel("startCaptureWithCompletionHandler:"), startBlk)
	select {
	case e := <-done:
		if e != 0 {
			sckActive.CompareAndSwap(s, nil)
			return nil, fmt.Errorf("start przechwytywania: %s", nsErrorText(e))
		}
	case <-time.After(10 * time.Second):
		sckActive.CompareAndSwap(s, nil)
		return nil, errors.New("start przechwytywania: brak odpowiedzi")
	}
	return s, nil
}

// onSample — nowa klatka z ScreenCaptureKit (wątek kolejki systemowej): kopia do bufora.
func (s *sckStream) onSample(sb uintptr) {
	pb := cmSampleBufferGetImageBuffer(sb)
	if pb == 0 {
		return // klatka bez obrazu (ekran się nie zmienił)
	}
	if cvPixelBufferLockBaseAddress(pb, 1) != 0 {
		return
	}
	defer cvPixelBufferUnlockBaseAddress(pb, 1)
	w, h := int(cvPixelBufferGetWidth(pb)), int(cvPixelBufferGetHeight(pb))
	stride := int(cvPixelBufferGetBytesPerRow(pb))
	base := cvPixelBufferGetBaseAddress(pb)
	if base == nil || w != s.w || h != s.h || stride < w*4 {
		return
	}
	src := unsafe.Slice(base, stride*(h-1)+w*4)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.front) != w*h*4 {
		s.front = make([]byte, w*h*4)
	}
	for y := range h {
		copy(s.front[y*w*4:(y+1)*w*4], src[y*stride:y*stride+w*4])
	}
	s.seq++
}

func (s *sckStream) stop() {
	sckActive.CompareAndSwap(s, nil)
	done := make(chan struct{}, 1)
	blk := objc.NewBlock(func(_ objc.Block, _ objc.ID) { done <- struct{}{} })
	s.stream.Send(sel("stopCaptureWithCompletionHandler:"), blk)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}
