package main

import (
	"image"
	"image/color"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/gofont/goregular"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/font/sfnt"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Ramka „Aktywne Wsparcie Techniczne”: animowany obrys ekranu w kolorach marki i „notch” u góry
// z nazwą osoby, która się połączyła. Tutaj tylko rysowanie (niezależne od systemu — testowane
// podglądem PNG); okna nakładki: overlay_windows.go.

const overlayTitle = "Aktywne Wsparcie Techniczne"

var (
	brandPink   = [3]float64{233, 30, 140}
	brandPurple = [3]float64{155, 38, 217}
	brandBlue   = [3]float64{99, 102, 241}
)

// borderColor — kolor obrysu w punkcie p∈[0,1) obwodu w chwili t (s): płynne przejście różowy → fiolet → indygo
// przesuwające się wokół ekranu i jaśniejszy „błysk” obiegający krawędź.
func borderColor(p, t float64) (r, g, b float64) {
	phase := p - t*0.08
	phase -= math.Floor(phase)
	x := phase * 3
	var c0, c1 [3]float64
	switch {
	case x < 1:
		c0, c1 = brandPink, brandPurple
	case x < 2:
		c0, c1 = brandPurple, brandBlue
		x--
	default:
		c0, c1 = brandBlue, brandPink
		x -= 2
	}
	k := 0.5 - 0.5*math.Cos(x*math.Pi)
	r = c0[0] + (c1[0]-c0[0])*k
	g = c0[1] + (c1[1]-c0[1])*k
	b = c0[2] + (c1[2]-c0[2])*k
	// błysk: krótki jasny odcinek obiegający ramkę co ~6 s
	d := p - math.Mod(t/6, 1)
	d -= math.Round(d)
	glow := math.Exp(-(d * d) / (2 * 0.018 * 0.018))
	r += (255 - r) * glow * 0.65
	g += (255 - g) * glow * 0.65
	b += (255 - b) * glow * 0.65
	return
}

// overlayStrip — jeden z czterech pasków obrysu (okno nakładki), w pikselach ekranu.
type overlayStrip struct {
	X, Y, W, H int
	side       byte // t, r, b, l
}

// borderStrips — paski wokół monitora: góra i dół na całą szerokość, boki pomiędzy.
func borderStrips(mx, my, mw, mh, thick int) []overlayStrip {
	return []overlayStrip{
		{mx, my, mw, thick, 't'},
		{mx + mw - thick, my + thick, thick, mh - 2*thick, 'r'},
		{mx, my + mh - thick, mw, thick, 'b'},
		{mx, my + thick, thick, mh - 2*thick, 'l'},
	}
}

// renderStrip rysuje pasek obrysu: linia `line` px przy krawędzi ekranu i miękka poświata do środka.
// Kolor zależy tylko od położenia wzdłuż obwodu, więc liczymy go raz na kolumnę/wiersz.
func renderStrip(img *image.RGBA, s overlayStrip, mx, my, mw, mh, line int, t float64) {
	thick := s.W
	length := s.H
	if s.side == 't' || s.side == 'b' {
		thick, length = s.H, s.W
	}
	per := float64(2*mw + 2*mh)
	alpha := make([]float64, thick) // wg odległości od krawędzi ekranu
	for d := range thick {
		if d < line {
			alpha[d] = 0.96
		} else {
			f := 1 - float64(d-line+1)/float64(thick-line+1)
			alpha[d] = 0.42 * f * f
		}
	}
	for i := range length {
		// położenie na obwodzie (zgodnie z ruchem wskazówek zegara od lewego górnego rogu)
		var pos float64
		switch s.side {
		case 't':
			pos = float64(s.X - mx + i)
		case 'r':
			pos = float64(mw) + float64(s.Y-my+i)
		case 'b':
			pos = float64(mw+mh) + float64(mw-(s.X-mx+i))
		case 'l':
			pos = float64(2*mw+mh) + float64(mh-(s.Y-my+i))
		}
		r, g, b := borderColor(pos/per, t)
		// górny i dolny pasek obejmują narożniki — tam dochodzi linia i poświata boków
		side := 0.0
		if (s.side == 't' || s.side == 'b') && (i < thick || i >= length-thick) {
			side = alpha[min(i, length-1-i)]
		}
		for d := range thick {
			a := max(alpha[d], side)
			var x, y int
			switch s.side {
			case 't':
				x, y = i, d
			case 'b':
				x, y = i, thick-1-d
			case 'l':
				x, y = d, i
			case 'r':
				x, y = thick-1-d, i
			}
			o := img.PixOffset(x, y)
			img.Pix[o+0] = uint8(r * a)
			img.Pix[o+1] = uint8(g * a)
			img.Pix[o+2] = uint8(b * a)
			img.Pix[o+3] = uint8(255 * a)
		}
	}
}

// ---------- notch ----------

type overlayFonts struct {
	bold, regular *opentype.Font
}

var (
	fontsOnce sync.Once
	fonts     overlayFonts
)

// loadOverlayFonts — fonty systemowe (Segoe UI na Windows), w razie braku — fonty Go wbudowane w agenta.
func loadOverlayFonts() overlayFonts {
	fontsOnce.Do(func() {
		var boldPaths, regPaths []string
		switch runtime.GOOS {
		case "windows":
			dir := filepath.Join(os.Getenv("WINDIR"), "Fonts")
			boldPaths = []string{filepath.Join(dir, "seguisb.ttf"), filepath.Join(dir, "segoeuib.ttf")}
			regPaths = []string{filepath.Join(dir, "segoeui.ttf")}
		case "darwin":
			// Helvetica Neue — systemowa czcionka macOS (kolekcja .ttc: odmiana po nazwie)
			boldPaths = []string{"/System/Library/Fonts/HelveticaNeue.ttc#Medium", "/System/Library/Fonts/HelveticaNeue.ttc#Bold", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"}
			regPaths = []string{"/System/Library/Fonts/HelveticaNeue.ttc#Regular", "/System/Library/Fonts/Supplemental/Arial.ttf"}
		}
		fonts.bold = firstFont(boldPaths, gobold.TTF)
		fonts.regular = firstFont(regPaths, goregular.TTF)
	})
	return fonts
}

func firstFont(paths []string, fallback []byte) *opentype.Font {
	for _, p := range paths {
		if file, sub, ok := strings.Cut(p, "#"); ok {
			if f := collectionFont(file, sub); f != nil {
				return f
			}
			continue
		}
		if b, err := os.ReadFile(p); err == nil {
			if f, err := opentype.Parse(b); err == nil {
				return f
			}
		}
	}
	f, _ := opentype.Parse(fallback)
	return f
}

// collectionFont — odmiana (np. „Medium”) z kolekcji czcionek .ttc.
func collectionFont(path, subfamily string) *opentype.Font {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	c, err := opentype.ParseCollection(b)
	if err != nil {
		return nil
	}
	for i := range c.NumFonts() {
		f, err := c.Font(i)
		if err != nil {
			continue
		}
		if name, err := f.Name(nil, sfnt.NameIDSubfamily); err == nil && name == subfamily {
			return f
		}
	}
	return nil
}

func face(f *opentype.Font, size float64) font.Face {
	fc, err := opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
	if err != nil {
		return nil
	}
	return fc
}

// notchLayout — wymiary i treść notcha (zależne od skali ekranu i długości nazwy).
type notchLayout struct {
	W, H                int
	scale               float64
	title, name         string
	titleFace, nameFace font.Face
	textX, dotX         float64
	// top — odstęp treści od górnej krawędzi (px): MacBook z wycięciem na kamerę — napis pod nim
	top float64
	// black — czarne wnętrze (łączy się ze sprzętowym wycięciem MacBooka)
	black bool
}

func cleanOverlayName(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 48 {
		s = string(r[:47]) + "…"
	}
	return s
}

func newNotchLayout(name string, scale float64) *notchLayout {
	return newNotchLayoutFor(name, scale, 0, 0)
}

// newNotchLayoutFor — notch co najmniej minW px szeroki, z treścią przesuniętą o top px w dół.
// Na MacBooku z notchem nasz notch jest przedłużeniem sprzętowego wycięcia (w stylu Dynamic Island).
func newNotchLayoutFor(name string, scale, minW, top float64) *notchLayout {
	f := loadOverlayFonts()
	l := &notchLayout{scale: scale, title: overlayTitle, name: cleanOverlayName(name)}
	l.titleFace = face(f.bold, 14*scale)
	l.nameFace = face(f.regular, 12.5*scale)
	tw := font.MeasureString(l.titleFace, l.title).Ceil()
	nw := 0
	if l.name != "" {
		nw = font.MeasureString(l.nameFace, l.name).Ceil()
	}
	shoulder := 14 * scale
	padX := 26 * scale
	dot := 18 * scale // kropka + odstęp
	content := float64(max(tw, nw)) + dot
	l.W = int(math.Ceil(max(content+2*padX+2*shoulder, minW)))
	l.top = top
	l.black = top > 0
	l.H = int(math.Ceil(58*scale + top))
	if l.name == "" {
		l.H = int(math.Ceil(42*scale + top))
	}
	// treść wyśrodkowana, gdy notch jest szerszy niż tekst (wycięcie na kamerę)
	l.dotX = (float64(l.W) - content) / 2
	l.textX = l.dotX + dot
	return l
}

// notchPath — kształt notcha: wklęsłe „ramiona” łączące się z górną krawędzią i zaokrąglony dół.
// inset > 0 daje kształt wewnętrzny (wnętrze nad obwódką).
func notchPath(z *vector.Rasterizer, w, h, s, r, inset float64) {
	si, ri := s+inset, math.Max(1, r-inset)
	z.MoveTo(0, 0)
	z.LineTo(float32(w), 0)
	z.QuadTo(float32(w-si), 0, float32(w-si), float32(math.Min(si, h-inset-ri)))
	z.LineTo(float32(w-si), float32(h-inset-ri))
	z.QuadTo(float32(w-si), float32(h-inset), float32(w-si-ri), float32(h-inset))
	z.LineTo(float32(si+ri), float32(h-inset))
	z.QuadTo(float32(si), float32(h-inset), float32(si), float32(h-inset-ri))
	z.LineTo(float32(si), float32(math.Min(si, h-inset-ri)))
	z.QuadTo(float32(si), 0, 0, 0)
	z.ClosePath()
}

// renderNotch rysuje notch w chwili t (pulsująca kropka „na żywo”, obwódka w kolorach obrysu).
// p0..p1 — położenie notcha na obwodzie ekranu (żeby obwódka kolorem przechodziła w obrys).
func renderNotch(l *notchLayout, t, p0, p1 float64) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, l.W, l.H))
	w, h := float64(l.W), float64(l.H)
	s, r := 14*l.scale, 18*l.scale
	line := math.Max(1.5, 2*l.scale)

	// obwódka: kształt zewnętrzny wypełniony gradientem obrysu
	z := vector.NewRasterizer(l.W, l.H)
	notchPath(z, w, h, s, r, 0)
	grad := image.NewRGBA(img.Bounds())
	for x := range l.W {
		cr, cg, cb := borderColor(p0+(p1-p0)*float64(x)/w, t)
		for y := range l.H {
			o := grad.PixOffset(x, y)
			grad.Pix[o], grad.Pix[o+1], grad.Pix[o+2], grad.Pix[o+3] = uint8(cr), uint8(cg), uint8(cb), 255
		}
	}
	z.Draw(img, img.Bounds(), grad, image.Point{})

	// wnętrze: ciemne, prawie nieprzezroczyste
	z = vector.NewRasterizer(l.W, l.H)
	notchPath(z, w, h, s, r, line)
	fill := color.RGBA{13, 13, 21, 246}
	if l.black {
		fill = color.RGBA{0, 0, 0, 255}
	}
	z.Draw(img, img.Bounds(), image.NewUniform(fill), image.Point{})

	// pulsująca kropka
	pulse := 0.5 + 0.5*math.Sin(t*2*math.Pi/1.6)
	cy := l.top + (h-l.top)/2
	if l.name != "" {
		cy = l.top + 22*l.scale
	}
	cx := l.dotX + 5*l.scale
	drawDot(img, cx, cy, (5+3*pulse)*l.scale, color.RGBA{uint8(233 * 0.35 * (1 - pulse)), uint8(30 * 0.35 * (1 - pulse)), uint8(140 * 0.35 * (1 - pulse)), uint8(255 * 0.35 * (1 - pulse))})
	drawDot(img, cx, cy, 4*l.scale, color.RGBA{233, 30, 140, 255})

	// tekst
	d := font.Drawer{Dst: img, Src: image.NewUniform(color.RGBA{246, 246, 252, 255}), Face: l.titleFace}
	m := l.titleFace.Metrics()
	if l.name == "" {
		d.Dot = fixed.P(int(math.Round(l.textX)), int(math.Round(cy+float64(m.Ascent-m.Descent)/128)))
		d.DrawString(l.title)
		return img
	}
	// tekst w pełnych pikselach — ułamkowe położenie rozmywa litery
	d.Dot = fixed.P(int(math.Round(l.textX)), int(math.Round(cy+float64(m.Ascent-m.Descent)/128)))
	d.DrawString(l.title)
	d2 := font.Drawer{Dst: img, Src: image.NewUniform(color.RGBA{190, 186, 214, 255}), Face: l.nameFace}
	d2.Dot = fixed.P(int(math.Round(l.textX)), int(math.Round(l.top+41*l.scale)))
	d2.DrawString(l.name)
	return img
}

// drawDot — wygładzone kółko (premultiplied, nakładane na obraz).
func drawDot(img *image.RGBA, cx, cy, rad float64, c color.RGBA) {
	z := vector.NewRasterizer(img.Bounds().Dx(), img.Bounds().Dy())
	const k = 0.5523 // przybliżenie okręgu krzywymi Béziera
	z.MoveTo(float32(cx+rad), float32(cy))
	z.CubeTo(float32(cx+rad), float32(cy+rad*k), float32(cx+rad*k), float32(cy+rad), float32(cx), float32(cy+rad))
	z.CubeTo(float32(cx-rad*k), float32(cy+rad), float32(cx-rad), float32(cy+rad*k), float32(cx-rad), float32(cy))
	z.CubeTo(float32(cx-rad), float32(cy-rad*k), float32(cx-rad*k), float32(cy-rad), float32(cx), float32(cy-rad))
	z.CubeTo(float32(cx+rad*k), float32(cy-rad), float32(cx+rad), float32(cy-rad*k), float32(cx+rad), float32(cy))
	z.ClosePath()
	z.Draw(img, img.Bounds(), image.NewUniform(c), image.Point{})
}
