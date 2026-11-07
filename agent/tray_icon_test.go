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

func TestTrayIcon(t *testing.T) {
	for _, n := range []int{16, 20, 24, 32} {
		img := renderTrayIcon(n, true)
		if img.Bounds().Dx() != n {
			t.Fatalf("rozmiar %d", img.Bounds().Dx())
		}
		if c := img.RGBAAt(n/2, n*3/10); c.R < 240 || c.G < 240 {
			t.Fatalf("%d px: brak białego dymka: %v", n, c)
		}
	}
	if dir := os.Getenv("OVERLAY_PREVIEW"); dir != "" {
		bg := image.NewRGBA(image.Rect(0, 0, 8*36+8, 2*36+8))
		draw.Draw(bg, bg.Bounds(), image.NewUniform(color.RGBA{32, 32, 32, 255}), image.Point{}, draw.Src)
		for i, n := range []int{16, 20, 24, 32} {
			for j, remote := range []bool{false, true} {
				img := renderTrayIcon(n, remote)
				p := image.Pt(8+i*72+j*36, 8+(32-n)/2)
				draw.Draw(bg, image.Rectangle{p, p.Add(image.Pt(n, n))}, img, image.Point{}, draw.Over)
			}
		}
		f, _ := os.Create(filepath.Join(dir, "tray-icons.png"))
		_ = png.Encode(f, bg)
		f.Close()
	}
}
