package main

import (
	"image"
	"image/color"

	"golang.org/x/image/vector"
)

// Ikona w zasobniku: biały dymek czatu na gradiencie OVERVNC (różowy → fioletowy); zielona kropka,
// gdy ktoś jest połączony z pulpitem. Obraz premultiplied RGBA w rozmiarze ikony systemu (16–32 px).
func renderTrayIcon(size int, remote bool) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	s := float64(size)
	// tło: zaokrąglony kwadrat z gradientem
	grad := image.NewRGBA(img.Bounds())
	for y := range size {
		for x := range size {
			t := float64(x+y) / (2 * s)
			o := grad.PixOffset(x, y)
			grad.Pix[o] = uint8(233 + (155-233)*t)
			grad.Pix[o+1] = uint8(30 + (38-30)*t)
			grad.Pix[o+2] = uint8(140 + (217-140)*t)
			grad.Pix[o+3] = 255
		}
	}
	z := vector.NewRasterizer(size, size)
	roundRect(z, 0, 0, s, s, s*0.24)
	z.Draw(img, img.Bounds(), grad, image.Point{})
	// dymek
	z = vector.NewRasterizer(size, size)
	bx, by, bw, bh := s*0.2, s*0.22, s*0.6, s*0.42
	roundRect(z, bx, by, bw, bh, s*0.12)
	z.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{255, 255, 255, 255}), image.Point{})
	z = vector.NewRasterizer(size, size)
	z.MoveTo(float32(bx+bw*0.22), float32(by+bh-1))
	z.LineTo(float32(bx+bw*0.22), float32(by+bh+s*0.16))
	z.LineTo(float32(bx+bw*0.48), float32(by+bh-1))
	z.ClosePath()
	z.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{255, 255, 255, 255}), image.Point{})
	if remote {
		r := s * 0.2
		drawDot(img, s-r-0.5, s-r-0.5, r+s*0.05, color.RGBA{255, 255, 255, 255})
		drawDot(img, s-r-0.5, s-r-0.5, r, color.RGBA{47, 210, 126, 255})
	}
	return img
}
