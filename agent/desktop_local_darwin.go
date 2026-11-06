package main

import (
	"os"
	"runtime"
	"unsafe"

	"github.com/ebitengine/purego"
)

// macOS: nasłuch zdarzeń (CGEventTap, tylko odczyt — wymaga tej samej zgody „Dostępność” co sterowanie).
// Zdarzenie niesie numer procesu, który je wysłał: 0 = fizyczna mysz/klawiatura, nasz PID = sterowanie zdalne.

const (
	fieldSourcePID     = 41 // kCGEventSourceUnixProcessID
	tapDisabledTimeout = 0xFFFFFFFE
	tapDisabledByUser  = 0xFFFFFFFF
)

func startLocalInputWatch() bool {
	if desktopTestMode() {
		return testLocalInput()
	}
	cg, err := purego.Dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return false
	}
	cf, err := purego.Dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", purego.RTLD_NOW|purego.RTLD_GLOBAL)
	if err != nil {
		return false
	}
	var (
		tapCreate   func(tap, place, opts uint32, mask uint64, cb, info uintptr) uintptr
		tapEnable   func(port uintptr, on bool)
		getField    func(ev uintptr, field uint32) int64
		portSource  func(alloc, port uintptr, order int) uintptr
		loopCurrent func() uintptr
		loopAdd     func(loop, src, mode uintptr)
		loopRun     func()
	)
	reg := purego.RegisterLibFunc
	reg(&tapCreate, cg, "CGEventTapCreate")
	reg(&tapEnable, cg, "CGEventTapEnable")
	reg(&getField, cg, "CGEventGetIntegerValueField")
	reg(&portSource, cf, "CFMachPortCreateRunLoopSource")
	reg(&loopCurrent, cf, "CFRunLoopGetCurrent")
	reg(&loopAdd, cf, "CFRunLoopAddSource")
	reg(&loopRun, cf, "CFRunLoopRun")
	modeSym, err := purego.Dlsym(cf, "kCFRunLoopCommonModes")
	if err != nil {
		return false
	}
	mode := **(**uintptr)(unsafe.Pointer(&modeSym))

	self := int64(os.Getpid())
	var port uintptr
	cb := purego.NewCallback(func(proxy uintptr, typ uint32, ev uintptr, info uintptr) uintptr {
		switch {
		case typ == tapDisabledTimeout || typ == tapDisabledByUser:
			if port != 0 {
				tapEnable(port, true)
			}
		case ev != 0 && getField(ev, fieldSourcePID) != self:
			markLocalInput()
		}
		return ev
	})
	// ruch, przyciski, przeciąganie, klawisze, modyfikatory, kółko
	var mask uint64
	for _, t := range []uint{1, 2, 3, 4, 5, 6, 7, 10, 11, 12, 22, 25, 26, 27} {
		mask |= 1 << t
	}

	ok := make(chan bool, 1)
	go func() {
		runtime.LockOSThread() // pętla zdarzeń CoreFoundation należy do wątku
		for _, loc := range []uint32{0 /* HID */, 1 /* sesja */} {
			if port = tapCreate(loc, 0, 1 /* tylko odczyt */, mask, cb, 0); port != 0 {
				break
			}
		}
		if port == 0 {
			ok <- false // brak zgody „Dostępność” — i tak nie ma sterowania
			return
		}
		loopAdd(loopCurrent(), portSource(0, port, 0), mode)
		ok <- true
		loopRun()
	}()
	return <-ok
}
