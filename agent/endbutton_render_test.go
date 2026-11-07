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

func TestEndButtonRender(t *testing.T) {
	for _, sc := range []float64{1, 1.5} {
		w, h, _ := endBtnSize(sc)
		for _, st := range []endBtnState{endBtnNormal, endBtnHover, endBtnPressed, endBtnBusy} {
			img := renderEndButton(sc, st)
			if b := img.Bounds(); b.Dx() != w || b.Dy() != h {
				t.Fatalf("rozmiar %v, oczekiwano %dx%d", b, w, h)
			}
		}
		// znaczek: pomarańczowy, środek przycisku — ciemne tło, rogi przezroczyste
		img := renderEndButton(sc, endBtnNormal)
		if c := img.RGBAAt(int(10*sc), h/2-int(12*sc)); c.R < 200 || c.G > 120 {
			t.Fatalf("brak pomarańczowego znaczka: %v", c)
		}
		if c := img.RGBAAt(0, 0); c.A != 0 {
			t.Fatalf("róg nieprzezroczysty: %v", c)
		}
	}
	if dir := os.Getenv("OVERLAY_PREVIEW"); dir != "" {
		// podgląd na tle podobnym do strony internetowej
		for i, sc := range []float64{1, 1.5} {
			w, h, _ := endBtnSize(sc)
			bg := image.NewRGBA(image.Rect(0, 0, w+40, 4*(h+20)+20))
			draw.Draw(bg, bg.Bounds(), image.NewUniform(color.RGBA{238, 236, 232, 255}), image.Point{}, draw.Src)
			for j, st := range []endBtnState{endBtnNormal, endBtnHover, endBtnPressed, endBtnBusy} {
				r := image.Rect(20, 20+j*(h+20), 20+w, 20+j*(h+20)+h)
				draw.Draw(bg, r, renderEndButton(sc, st), image.Point{}, draw.Over)
			}
			f, _ := os.Create(filepath.Join(dir, []string{"endbutton-100.png", "endbutton-150.png"}[i]))
			_ = png.Encode(f, bg)
			f.Close()
		}
	}
}
