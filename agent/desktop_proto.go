package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"io"
)

// Pulpit zdalny — wspólne elementy usługi i procesu pomocniczego.
//
// Usługa agenta (na Windows w sesji 0, bez dostępu do ekranu) uruchamia proces pomocniczy
// „desktop-helper” w sesji użytkownika i rozmawia z nim przez stdin/stdout:
//
//	[1 bajt typ][4 bajty długość BE][dane]
//
// pomocnik -> usługa: 'F' klatka, 'I' informacje o monitorach (JSON), 'L' wpis do logu
// usługa -> pomocnik: 'N' zgoda na kolejną klatkę (tempo wg potwierdzeń przeglądarki),
//
//	'E' zdarzenie (wejście / konfiguracja, JSON), 'Q' koniec
//
// Do przeglądarki trafia [typ][dane] typu 'F' i 'I' bez zmian.
const (
	msgFrame = 'F'
	msgInfo  = 'I'
	msgLog   = 'L'
	msgNext  = 'N'
	msgEvent = 'E'
	msgQuit  = 'Q'

	maxHelperMsg = 32 << 20
	tileSize     = 128
)

func writeMsg(w io.Writer, typ byte, payload []byte) error {
	b := make([]byte, 5+len(payload))
	b[0] = typ
	binary.BigEndian.PutUint32(b[1:5], uint32(len(payload)))
	copy(b[5:], payload)
	_, err := w.Write(b)
	return err
}

func readMsg(r *bufio.Reader) (byte, []byte, error) {
	var head [5]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(head[1:])
	if n > maxHelperMsg {
		return 0, nil, fmt.Errorf("za duża wiadomość pomocnika (%d B)", n)
	}
	p := make([]byte, n)
	if _, err := io.ReadFull(r, p); err != nil {
		return 0, nil, err
	}
	return head[0], p, nil
}

// MonitorInfo — monitor w układzie wirtualnego pulpitu (piksele fizyczne).
type MonitorInfo struct {
	Index   int    `json:"index"`
	X       int    `json:"x"`
	Y       int    `json:"y"`
	W       int    `json:"w"`
	H       int    `json:"h"`
	Primary bool   `json:"primary"`
	Name    string `json:"name,omitempty"`
}

type DesktopInfo struct {
	Monitors []MonitorInfo `json:"monitors"`
	Current  int           `json:"current"`
	Desktop  string        `json:"desktop,omitempty"` // np. "Default" albo "Winlogon" (ekran blokady/UAC)
}

// InputEvent — zdarzenie z przeglądarki. Współrzędne X/Y w zakresie 0..1 względem bieżącego monitora.
type InputEvent struct {
	T       string  `json:"t"` // m — ruch, b — przycisk, w — kółko, k — klawisz, cfg — ustawienia, kf — pełna klatka
	X       float64 `json:"x,omitempty"`
	Y       float64 `json:"y,omitempty"`
	B       int     `json:"b,omitempty"` // 0 lewy, 1 środkowy, 2 prawy
	D       bool    `json:"d,omitempty"` // wciśnięty
	DY      int     `json:"dy,omitempty"`
	Code    string  `json:"code,omitempty"` // KeyboardEvent.code
	Quality string  `json:"quality,omitempty"`
	Monitor *int    `json:"monitor,omitempty"`
}

// qualitySettings — jakość JPEG i skala (2 = połowa rozdzielczości, dla wolnych łączy).
func qualitySettings(q string) (jpegQ, scale int) {
	switch q {
	case "low":
		return 45, 2
	case "high":
		return 85, 1
	default:
		return 65, 1
	}
}

// frameEncoder wysyła tylko zmienione kafelki 128×128 względem poprzedniej klatki.
type frameEncoder struct {
	prev []byte
	w, h int
	seq  uint32
}

func (e *frameEncoder) reset() { e.prev = nil }

// encode przyjmuje obraz BGRA (stride w*4) i zwraca zakodowaną klatkę albo nil, gdy nic się nie zmieniło.
//
// Format: seq u32, szer u16, wys u16, liczba kafelków u16, potem dla każdego: x, y, w, h (u16), długość u32, JPEG.
// Wymiary i współrzędne są już po przeskalowaniu.
func (e *frameEncoder) encode(bgra []byte, w, h int, quality string) ([]byte, error) {
	if len(bgra) < w*h*4 || w <= 0 || h <= 0 {
		return nil, errors.New("nieprawidłowy bufor obrazu")
	}
	jq, scale := qualitySettings(quality)
	full := e.prev == nil || e.w != w || e.h != h
	var tiles bytes.Buffer
	count := 0
	for ty := 0; ty < h; ty += tileSize {
		th := min(tileSize, h-ty)
		for tx := 0; tx < w; tx += tileSize {
			tw := min(tileSize, w-tx)
			if !full && !tileChanged(e.prev, bgra, w, tx, ty, tw, th) {
				continue
			}
			img := tileRGBA(bgra, w, tx, ty, tw, th, scale)
			var jb bytes.Buffer
			if err := jpeg.Encode(&jb, img, &jpeg.Options{Quality: jq}); err != nil {
				return nil, err
			}
			var hdr [12]byte
			binary.BigEndian.PutUint16(hdr[0:], uint16(tx/scale))
			binary.BigEndian.PutUint16(hdr[2:], uint16(ty/scale))
			binary.BigEndian.PutUint16(hdr[4:], uint16(img.Rect.Dx()))
			binary.BigEndian.PutUint16(hdr[6:], uint16(img.Rect.Dy()))
			binary.BigEndian.PutUint32(hdr[8:], uint32(jb.Len()))
			tiles.Write(hdr[:])
			tiles.Write(jb.Bytes())
			count++
		}
	}
	if len(e.prev) != len(bgra) {
		e.prev = make([]byte, len(bgra))
	}
	copy(e.prev, bgra[:w*h*4])
	e.w, e.h = w, h
	if count == 0 {
		return nil, nil
	}
	e.seq++
	var out bytes.Buffer
	var head [10]byte
	binary.BigEndian.PutUint32(head[0:], e.seq)
	binary.BigEndian.PutUint16(head[4:], uint16((w+scale-1)/scale))
	binary.BigEndian.PutUint16(head[6:], uint16((h+scale-1)/scale))
	binary.BigEndian.PutUint16(head[8:], uint16(count))
	out.Write(head[:])
	out.Write(tiles.Bytes())
	return out.Bytes(), nil
}

func tileChanged(prev, cur []byte, stride, x, y, w, h int) bool {
	for row := y; row < y+h; row++ {
		off := (row*stride + x) * 4
		if !bytes.Equal(prev[off:off+w*4], cur[off:off+w*4]) {
			return true
		}
	}
	return false
}

// tileRGBA wycina kafelek z BGRA do RGBA (z opcjonalnym zmniejszeniem przez pomijanie pikseli).
func tileRGBA(bgra []byte, stride, x, y, w, h, scale int) *image.RGBA {
	ow, oh := (w+scale-1)/scale, (h+scale-1)/scale
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for oy := range oh {
		src := ((y+oy*scale)*stride + x) * 4
		dst := oy * img.Stride
		for ox := range ow {
			s := src + ox*scale*4
			d := dst + ox*4
			img.Pix[d], img.Pix[d+1], img.Pix[d+2], img.Pix[d+3] = bgra[s+2], bgra[s+1], bgra[s], 255
		}
	}
	return img
}
