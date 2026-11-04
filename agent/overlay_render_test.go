package main

import (
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// composeOverlay — cały ekran z nakładką (jak złoży go Windows) — do testów i podglądu.
func composeOverlay(w, h int, name string, scale, t float64) *image.RGBA {
	screen := image.NewRGBA(image.Rect(0, 0, w, h))
	// „pulpit”: ukośny gradient, żeby było widać przezroczystość
	for y := range h {
		for x := range w {
			o := screen.PixOffset(x, y)
			screen.Pix[o], screen.Pix[o+1], screen.Pix[o+2], screen.Pix[o+3] = uint8(40+x*60/w), uint8(70+y*80/h), 110, 255
		}
	}
	thick := int(14 * scale)
	for _, s := range borderStrips(0, 0, w, h, thick) {
		img := image.NewRGBA(image.Rect(0, 0, s.W, s.H))
		renderStrip(img, s, 0, 0, w, h, int(4*scale), t)
		draw.Draw(screen, image.Rect(s.X, s.Y, s.X+s.W, s.Y+s.H), img, image.Point{}, draw.Over)
	}
	l := newNotchLayout(name, scale)
	x0 := (w - l.W) / 2
	per := float64(2*w + 2*h)
	n := renderNotch(l, t, float64(x0)/per, float64(x0+l.W)/per)
	draw.Draw(screen, image.Rect(x0, 0, x0+l.W, l.H), n, image.Point{}, draw.Over)
	return screen
}

func TestOverlayRender(t *testing.T) {
	img := composeOverlay(1280, 720, "Paweł Roloff", 1, 1.3)
	// obrys przy krawędzi jest kryjący i w kolorach marki (nie czarny, nie przezroczysty)
	c := img.RGBAAt(640, 700+19)
	if c.R < 80 && c.B < 80 {
		t.Fatalf("obrys u dołu nie ma koloru: %v", c)
	}
	// środek ekranu bez zmian (nakładka nie zasłania pulpitu)
	if got := img.RGBAAt(640, 400); got != (color.RGBA{uint8(40 + 640*60/1280), uint8(70 + 400*80/720), 110, 255}) {
		t.Fatalf("środek ekranu zmieniony: %v", got)
	}
	// notch na środku u góry jest ciemny
	if c := img.RGBAAt(640, 30); c.R > 60 && c.G > 60 {
		t.Fatalf("notch nie jest ciemny: %v", c)
	}
	// długa nazwa jest przycinana, notch nie rośnie bez końca
	l := newNotchLayout(string(make([]rune, 0))+"Bardzo długa nazwa osoby z zespołu, która nie mieści się w notchu wcale", 1)
	if l.W > 700 {
		t.Fatalf("notch za szeroki: %d", l.W)
	}
	if dir := os.Getenv("OVERLAY_PREVIEW"); dir != "" {
		for i, sc := range []float64{1, 1.5} {
			f, _ := os.Create(filepath.Join(dir, []string{"overlay-100.png", "overlay-150.png"}[i]))
			_ = png.Encode(f, composeOverlay(int(1280*sc), int(720*sc), "Paweł Roloff", sc, 1.3))
			f.Close()
		}
		f, _ := os.Create(filepath.Join(dir, "overlay-noname.png"))
		_ = png.Encode(f, composeOverlay(1280, 720, "", 1, 3.1))
		f.Close()
	}
}
