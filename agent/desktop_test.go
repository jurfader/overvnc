package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"image/jpeg"
	"testing"
)

func solid(w, h int, b, g, r byte) []byte {
	buf := make([]byte, w*h*4)
	for i := 0; i < len(buf); i += 4 {
		buf[i], buf[i+1], buf[i+2], buf[i+3] = b, g, r, 255
	}
	return buf
}

type decodedTile struct {
	x, y, w, h int
	jpg        []byte
}

func parseFrame(t *testing.T, f []byte) (w, h int, tiles []decodedTile) {
	t.Helper()
	w, h = int(binary.BigEndian.Uint16(f[4:])), int(binary.BigEndian.Uint16(f[6:]))
	n := int(binary.BigEndian.Uint16(f[8:]))
	p := f[10:]
	for range n {
		tl := decodedTile{int(binary.BigEndian.Uint16(p[0:])), int(binary.BigEndian.Uint16(p[2:])), int(binary.BigEndian.Uint16(p[4:])), int(binary.BigEndian.Uint16(p[6:])), nil}
		l := int(binary.BigEndian.Uint32(p[8:]))
		tl.jpg = p[12 : 12+l]
		p = p[12+l:]
		tiles = append(tiles, tl)
	}
	if len(p) != 0 {
		t.Fatalf("nadmiarowe bajty w klatce: %d", len(p))
	}
	return
}

func TestFrameEncoderDiff(t *testing.T) {
	var e frameEncoder
	w, h := 300, 200 // 3×2 kafelki (128 px; ostatnie niepełne)
	img := solid(w, h, 10, 20, 30)

	f, err := e.encode(img, w, h, "medium")
	if err != nil || f == nil {
		t.Fatal(err)
	}
	fw, fh, tiles := parseFrame(t, f)
	if fw != 300 || fh != 200 || len(tiles) != 6 {
		t.Fatalf("pierwsza klatka: %dx%d, %d kafelków", fw, fh, len(tiles))
	}
	// kafelek dekoduje się jako poprawny JPEG o właściwych wymiarach, z zachowanym kolorem (BGRA -> RGB)
	im, err := jpeg.Decode(bytes.NewReader(tiles[5].jpg))
	if err != nil || im.Bounds().Dx() != 300-256 || im.Bounds().Dy() != 200-128 {
		t.Fatalf("kafelek: %v %v", err, im.Bounds())
	}
	r, g, b, _ := im.At(5, 5).RGBA()
	if r>>8 < 25 || r>>8 > 35 || g>>8 < 15 || g>>8 > 25 || b>>8 > 15 {
		t.Errorf("kolor po konwersji: r=%d g=%d b=%d (oczekiwano ~30,20,10)", r>>8, g>>8, b>>8)
	}

	// bez zmian — brak klatki
	if f, _ := e.encode(img, w, h, "medium"); f != nil {
		t.Error("niezmieniony obraz nie powinien dawać klatki")
	}
	// zmiana jednego piksela w kafelku (1,1) -> tylko ten kafelek
	img[(150*w+200)*4] = 99
	f, _ = e.encode(img, w, h, "medium")
	_, _, tiles = parseFrame(t, f)
	if len(tiles) != 1 || tiles[0].x != 128 || tiles[0].y != 128 {
		t.Fatalf("zmiana jednego piksela: %+v", tiles)
	}
	// reset (np. nowy widz, zmiana monitora) -> pełna klatka
	e.reset()
	f, _ = e.encode(img, w, h, "medium")
	if _, _, tiles = parseFrame(t, f); len(tiles) != 6 {
		t.Errorf("po reset: %d kafelków", len(tiles))
	}
}

func TestFrameEncoderLowQualityHalvesSize(t *testing.T) {
	var e frameEncoder
	f, _ := e.encode(solid(256, 256, 1, 2, 3), 256, 256, "low")
	w, h, tiles := parseFrame(t, f)
	if w != 128 || h != 128 || len(tiles) != 4 || tiles[3].x != 64 || tiles[3].w != 64 {
		t.Fatalf("niska jakość: %dx%d %+v", w, h, tiles)
	}
}

func TestHelperMessageFraming(t *testing.T) {
	var buf bytes.Buffer
	writeMsg(&buf, msgFrame, []byte("klatka"))
	writeMsg(&buf, msgNext, nil)
	r := bufio.NewReader(&buf)
	typ, p, err := readMsg(r)
	if err != nil || typ != msgFrame || string(p) != "klatka" {
		t.Fatalf("%c %q %v", typ, p, err)
	}
	if typ, p, err = readMsg(r); err != nil || typ != msgNext || len(p) != 0 {
		t.Fatalf("%c %q %v", typ, p, err)
	}
	// uszkodzony nagłówek z ogromną długością — odrzucony, bez alokacji 4 GB
	bad := []byte{msgFrame, 0xFF, 0xFF, 0xFF, 0xFF}
	if _, _, err := readMsg(bufio.NewReader(bytes.NewReader(bad))); err == nil {
		t.Error("za duża wiadomość powinna być odrzucona")
	}
}

func TestScanCodes(t *testing.T) {
	cases := []struct {
		code string
		sc   uint16
		ext  bool
	}{
		{"KeyA", 0x1E, false}, {"Enter", 0x1C, false}, {"ArrowUp", 0x48, true}, {"AltRight", 0x38, true},
		{"Delete", 0x53, true}, {"NumpadEnter", 0x1C, true}, {"Backquote", 0x29, false}, {"MetaLeft", 0x5B, true},
	}
	for _, c := range cases {
		sc, ext, ok := scanCodeFor(c.code)
		if !ok || sc != c.sc || ext != c.ext {
			t.Errorf("%s: sc=%#x ext=%v ok=%v", c.code, sc, ext, ok)
		}
	}
	if _, _, ok := scanCodeFor("Nieistniejący"); ok {
		t.Error("nieznany kod nie może mieć scancode'u")
	}
}
