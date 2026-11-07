package main

import (
	"image"
	"image/color"
	"math"

	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Przycisk „Zakończ i usuń moje dane” na ekranie kiosku — kolory jak tapeta BIGFOTO (ciemne tło,
// pomarańczowy znaczek ✓ jak w karcie „Kończysz pracę?”). Rysowany w Go, wyświetlany oknem warstwowym.

type endBtnState int

const (
	endBtnNormal endBtnState = iota
	endBtnHover
	endBtnPressed
	endBtnBusy
)

const (
	endBtnLabel     = "Zakończ i usuń moje dane"
	endBtnBusyLabel = "Usuwam dane…"
)

var endBtnOrange = color.RGBA{255, 92, 24, 255}

// endBtnSize — wymiary przycisku (stałe dla danej skali — zmiana napisu nie zmienia okna).
func endBtnSize(scale float64) (w, h int, f font.Face) {
	f = face(loadOverlayFonts().bold, 15*scale)
	h = int(math.Round(52 * scale))
	tw := font.MeasureString(f, endBtnLabel).Ceil()
	w = int(math.Round(8*scale)) + int(math.Round(36*scale)) + int(math.Round(12*scale)) + tw + int(math.Round(22*scale))
	return w, h, f
}

func renderEndButton(scale float64, st endBtnState) *image.RGBA {
	w, h, f := endBtnSize(scale)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	fw, fh := float64(w), float64(h)

	bg := color.RGBA{43, 42, 40, 240}
	switch st {
	case endBtnHover:
		bg = color.RGBA{58, 56, 53, 245}
	case endBtnPressed:
		bg = color.RGBA{30, 29, 28, 250}
	}
	// obwódka (jaśniejsza) i tło
	z := vector.NewRasterizer(w, h)
	roundRect(z, 0, 0, fw, fh, fh/2)
	z.Draw(img, img.Bounds(), image.NewUniform(color.RGBA{60, 58, 56, 60}), image.Point{})
	z = vector.NewRasterizer(w, h)
	inset := math.Max(1, scale)
	roundRect(z, inset, inset, fw-2*inset, fh-2*inset, fh/2-inset)
	z.Draw(img, img.Bounds(), image.NewUniform(bg), image.Point{})

	// pomarańczowy kwadrat z ✓
	pad := 8 * scale
	icon := 36 * scale
	iy := (fh - icon) / 2
	z = vector.NewRasterizer(w, h)
	roundRect(z, pad, iy, icon, icon, 10*scale)
	orange := endBtnOrange
	if st == endBtnBusy {
		orange = color.RGBA{150, 70, 35, 255}
	}
	z.Draw(img, img.Bounds(), image.NewUniform(orange), image.Point{})
	ix, cy := pad+icon/2, fh/2
	stroke(img, [][2]float64{{ix - 8*scale, cy}, {ix - 2.5*scale, cy + 5.5*scale}, {ix + 8.5*scale, cy - 6*scale}}, 2.6*scale, color.RGBA{255, 255, 255, 255})

	// napis
	label := endBtnLabel
	if st == endBtnBusy {
		label = endBtnBusyLabel
	}
	m := f.Metrics()
	d := font.Drawer{Dst: img, Src: image.NewUniform(color.RGBA{250, 248, 245, 255}), Face: f}
	d.Dot = fixed.P(int(math.Round(pad+icon+12*scale)), int(math.Round(cy+float64(m.Ascent-m.Descent)/128)))
	d.DrawString(label)
	return img
}

// roundRect — prostokąt z zaokrąglonymi rogami (ścieżka rasteryzatora).
func roundRect(z *vector.Rasterizer, x, y, w, h, r float64) {
	r = math.Min(r, math.Min(w, h)/2)
	const k = 0.5523
	p := func(a, b float64) (float32, float32) { return float32(a), float32(b) }
	z.MoveTo(p(x+r, y))
	z.LineTo(p(x+w-r, y))
	ax, ay := p(x+w-r+r*k, y)
	bx, by := p(x+w, y+r-r*k)
	cx, cy := p(x+w, y+r)
	z.CubeTo(ax, ay, bx, by, cx, cy)
	z.LineTo(p(x+w, y+h-r))
	ax, ay = p(x+w, y+h-r+r*k)
	bx, by = p(x+w-r+r*k, y+h)
	cx, cy = p(x+w-r, y+h)
	z.CubeTo(ax, ay, bx, by, cx, cy)
	z.LineTo(p(x+r, y+h))
	ax, ay = p(x+r-r*k, y+h)
	bx, by = p(x, y+h-r+r*k)
	cx, cy = p(x, y+h-r)
	z.CubeTo(ax, ay, bx, by, cx, cy)
	z.LineTo(p(x, y+r))
	ax, ay = p(x, y+r-r*k)
	bx, by = p(x+r-r*k, y)
	cx, cy = p(x+r, y)
	z.CubeTo(ax, ay, bx, by, cx, cy)
	z.ClosePath()
}

// stroke — łamana o grubości width (odcinki jako czworokąty + okrągłe połączenia).
func stroke(img *image.RGBA, pts [][2]float64, width float64, c color.RGBA) {
	for i := 0; i+1 < len(pts); i++ {
		a, b := pts[i], pts[i+1]
		dx, dy := b[0]-a[0], b[1]-a[1]
		l := math.Hypot(dx, dy)
		if l == 0 {
			continue
		}
		nx, ny := -dy/l*width/2, dx/l*width/2
		z := vector.NewRasterizer(img.Bounds().Dx(), img.Bounds().Dy())
		z.MoveTo(float32(a[0]+nx), float32(a[1]+ny))
		z.LineTo(float32(b[0]+nx), float32(b[1]+ny))
		z.LineTo(float32(b[0]-nx), float32(b[1]-ny))
		z.LineTo(float32(a[0]-nx), float32(a[1]-ny))
		z.ClosePath()
		z.Draw(img, img.Bounds(), image.NewUniform(c), image.Point{})
	}
	for _, p := range pts {
		drawDot(img, p[0], p[1], width/2, c)
	}
}
