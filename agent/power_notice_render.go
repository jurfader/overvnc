package main

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"strings"
	"time"

	"golang.org/x/image/font"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Okienko „Komputer zostanie uruchomiony ponownie za …” na ekranie użytkownika (prawy dolny róg, nad
// paskiem zadań): odliczanie, prośba o zapisanie pracy i komunikat administratora. Można je zwinąć do
// małej plakietki; w ostatniej minucie rozwija się samo i robi się czerwone.

type powerNoticeState struct {
	Action    string // reboot | shutdown
	Remaining time.Duration
	Message   string
	Collapsed bool
	Hover     bool // nad przyciskiem „Zwiń” / plakietką
}

var (
	pnPink   = color.RGBA{233, 30, 140, 255}
	pnPurple = color.RGBA{155, 38, 217, 255}
	pnRed    = color.RGBA{239, 68, 68, 255}
	pnInk    = color.RGBA{248, 246, 252, 255}
	pnInk2   = color.RGBA{196, 190, 210, 255}
)

const (
	pnWidth       = 380
	pnMsgMaxLines = 3
	pnUrgent      = time.Minute // ostatnia minuta: bez zwijania, kolor ostrzegawczy
)

func pnTitle(action string) string {
	if action == "shutdown" {
		return "Komputer zostanie wyłączony"
	}
	return "Komputer zostanie uruchomiony ponownie"
}

func pnShort(action string) string {
	if action == "shutdown" {
		return "Wyłączenie za"
	}
	return "Restart za"
}

const pnBody = "Zapisz swoją pracę i zamknij programy — niezapisane zmiany zostaną utracone."

// formatCountdown — 14:32, 1:05:09; po terminie 0:00.
func formatCountdown(d time.Duration) string {
	s := int(math.Ceil(d.Seconds()))
	if s < 0 {
		s = 0
	}
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s/60%60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// wrapText — podział na linie mieszczące się w szerokości (najwyżej maxLines, ostatnia z „…”).
func wrapText(f font.Face, text string, width int, maxLines int) []string {
	var lines []string
	cur := ""
	for _, w := range strings.Fields(text) {
		next := w
		if cur != "" {
			next = cur + " " + w
		}
		if font.MeasureString(f, next).Ceil() <= width || cur == "" {
			cur = next
			continue
		}
		lines = append(lines, cur)
		cur = w
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	if len(lines) > maxLines {
		lines = lines[:maxLines]
		last := lines[maxLines-1]
		for last != "" && font.MeasureString(f, last+"…").Ceil() > width {
			r := []rune(last)
			last = string(r[:len(r)-1])
		}
		lines[maxLines-1] = strings.TrimSpace(last) + "…"
	}
	return lines
}

type pnLayout struct {
	scale                   float64
	w, h                    int
	title, big, body, small font.Face
	bodyLines, msgLines     []string
	// przycisk „Zwiń” (współrzędne w obrazie) i plakietka po zwinięciu
	collapse, pill image.Rectangle
}

// powerNoticeLayout — rozmiar okna jest stały dla danego komunikatu (rysunek zwiniętej plakietki
// mieści się w prawym dolnym rogu; przezroczyste piksele okna warstwowego są „przeklikiwalne”).
func powerNoticeLayout(scale float64, message string) pnLayout {
	fonts := loadOverlayFonts()
	L := pnLayout{scale: scale}
	L.title = face(fonts.bold, 14*scale)
	L.big = face(fonts.bold, 34*scale)
	L.body = face(fonts.regular, 13*scale)
	L.small = face(fonts.bold, 12.5*scale)
	L.w = int(math.Round(pnWidth * scale))
	inner := L.w - int(math.Round(2*20*scale))
	L.bodyLines = wrapText(L.body, pnBody, inner, 3)
	if m := strings.TrimSpace(message); m != "" {
		L.msgLines = wrapText(L.body, "„"+m+"”", inner, pnMsgMaxLines)
	}
	line := 19 * scale
	h := 18*scale + 40*scale /* ikona + tytuł */ + 8*scale + 44*scale /* licznik */ + 6*scale + float64(len(L.bodyLines))*line
	if len(L.msgLines) > 0 {
		h += 8*scale + float64(len(L.msgLines))*line
	}
	h += 14*scale + 30*scale /* przycisk */ + 16*scale
	L.h = int(math.Round(h))
	bw, bh := font.MeasureString(L.small, "Zwiń").Ceil()+int(28*scale), int(math.Round(30*scale))
	L.collapse = image.Rect(L.w-int(20*scale)-bw, L.h-int(16*scale)-bh, L.w-int(20*scale), L.h-int(16*scale))
	return L
}

func pnPillRect(L pnLayout, label string) image.Rectangle {
	ph := int(math.Round(44 * L.scale))
	pw := int(math.Round(14*L.scale)) + int(math.Round(26*L.scale)) + int(math.Round(10*L.scale)) + font.MeasureString(L.small, label).Ceil() + int(math.Round(18*L.scale))
	return image.Rect(L.w-pw, L.h-ph, L.w, L.h)
}

func renderPowerNotice(L pnLayout, st powerNoticeState) (*image.RGBA, image.Rectangle) {
	img := image.NewRGBA(image.Rect(0, 0, L.w, L.h))
	s := L.scale
	urgent := st.Remaining <= pnUrgent
	accent := pnPink
	if urgent {
		accent = pnRed
	}
	count := formatCountdown(st.Remaining)

	if st.Collapsed && !urgent {
		label := pnShort(st.Action) + " " + count
		r := pnPillRect(L, label)
		bg := color.RGBA{28, 25, 36, 240}
		if st.Hover {
			bg = color.RGBA{44, 40, 56, 245}
		}
		fillRound(img, r, float64(r.Dy())/2, color.RGBA{40, 40, 40, 40})
		fillRound(img, r.Inset(int(math.Max(1, s))), float64(r.Dy())/2-math.Max(1, s), bg)
		ic := 26 * s
		cx, cy := float64(r.Min.X)+14*s+ic/2, float64(r.Min.Y)+float64(r.Dy())/2
		gradientDot(img, cx, cy, ic/2, accent, pnPurple)
		drawPowerIcon(img, st.Action, cx, cy, ic*0.3, s)
		drawText(img, L.small, label, float64(r.Min.X)+14*s+ic+10*s, cy, pnInk)
		return img, r
	}

	// karta (kolory premultiplikowane: R,G,B ≤ A)
	full := img.Bounds()
	fillRound(img, full, 16*s, color.RGBA{34, 34, 34, 34})
	fillRound(img, full.Inset(int(math.Max(1, s))), 16*s-math.Max(1, s), color.RGBA{24, 21, 32, 246})

	x := 20 * s
	y := 18 * s
	ic := 40 * s
	gradientDot(img, x+ic/2, y+ic/2, ic/2, accent, pnPurple)
	drawPowerIcon(img, st.Action, x+ic/2, y+ic/2, ic*0.28, s)
	drawText(img, L.title, pnTitle(st.Action), x+ic+12*s, y+ic/2, pnInk)
	y += ic + 8*s

	// licznik + „za”
	m := L.big.Metrics()
	d := font.Drawer{Dst: img, Src: image.NewUniform(pnInk2), Face: L.body}
	d.Dot = fixed.P(int(x), int(y+float64(m.Ascent.Ceil())))
	d.DrawString("za ")
	d.Src = image.NewUniform(map[bool]color.RGBA{true: pnRed, false: pnInk}[urgent])
	d.Face = L.big
	d.DrawString(count)
	y += 44*s + 6*s

	line := 19 * s
	for _, l := range L.bodyLines {
		drawTextTop(img, L.body, l, x, y, pnInk2)
		y += line
	}
	if len(L.msgLines) > 0 {
		y += 8 * s
		for _, l := range L.msgLines {
			drawTextTop(img, L.body, l, x, y, pnInk)
			y += line
		}
	}

	// „Zwiń” (niedostępne w ostatniej minucie)
	if !urgent {
		r := L.collapse
		bg := color.RGBA{18, 18, 18, 18}
		if st.Hover {
			bg = color.RGBA{36, 36, 36, 36}
		}
		fillRound(img, r, float64(r.Dy())/2, bg)
		tw := font.MeasureString(L.small, "Zwiń").Ceil()
		drawText(img, L.small, "Zwiń", float64(r.Min.X)+float64(r.Dx()-tw)/2, float64(r.Min.Y)+float64(r.Dy())/2, pnInk)
		return img, r
	}
	return img, image.Rectangle{}
}

func fillRound(img *image.RGBA, r image.Rectangle, rad float64, c color.RGBA) {
	z := vector.NewRasterizer(img.Bounds().Dx(), img.Bounds().Dy())
	roundRect(z, float64(r.Min.X), float64(r.Min.Y), float64(r.Dx()), float64(r.Dy()), rad)
	z.Draw(img, img.Bounds(), image.NewUniform(c), image.Point{})
}

// gradientDot — koło z gradientem (lewy górny → prawy dolny).
func gradientDot(img *image.RGBA, cx, cy, rad float64, a, b color.RGBA) {
	x0, y0 := int(math.Floor(cx-rad)), int(math.Floor(cy-rad))
	x1, y1 := int(math.Ceil(cx+rad)), int(math.Ceil(cy+rad))
	for py := max(y0, 0); py < min(y1, img.Bounds().Dy()); py++ {
		for px := max(x0, 0); px < min(x1, img.Bounds().Dx()); px++ {
			dx, dy := float64(px)+0.5-cx, float64(py)+0.5-cy
			cov := math.Max(0, math.Min(1, rad-math.Hypot(dx, dy)+0.5))
			if cov == 0 {
				continue
			}
			t := math.Max(0, math.Min(1, (dx+dy)/(4*rad)+0.5))
			c := color.RGBA{
				uint8(float64(a.R)*(1-t) + float64(b.R)*t),
				uint8(float64(a.G)*(1-t) + float64(b.G)*t),
				uint8(float64(a.B)*(1-t) + float64(b.B)*t), 255,
			}
			blendPx(img, px, py, c, cov)
		}
	}
}

func blendPx(img *image.RGBA, x, y int, c color.RGBA, cov float64) {
	i := img.PixOffset(x, y)
	a := cov * float64(c.A) / 255
	p := img.Pix[i : i+4]
	p[0] = uint8(float64(c.R)*a + float64(p[0])*(1-a))
	p[1] = uint8(float64(c.G)*a + float64(p[1])*(1-a))
	p[2] = uint8(float64(c.B)*a + float64(p[2])*(1-a))
	p[3] = uint8(255*a + float64(p[3])*(1-a))
}

// drawPowerIcon — strzałka w kółko (restart) albo symbol zasilania (wyłączenie), biała.
func drawPowerIcon(img *image.RGBA, action string, cx, cy, r, s float64) {
	white := color.RGBA{255, 255, 255, 255}
	w := 2.2 * s
	var pts [][2]float64
	if action == "shutdown" {
		for a := -60.0; a <= 240; a += 10 {
			t := (a - 90) * math.Pi / 180
			pts = append(pts, [2]float64{cx + r*math.Cos(t), cy - r*math.Sin(t)})
		}
		stroke(img, pts, w, white)
		stroke(img, [][2]float64{{cx, cy - r*1.15}, {cx, cy - r*0.15}}, w, white)
		return
	}
	// łuk ~300° i grot na końcu
	for a := 40.0; a <= 330; a += 10 {
		t := a * math.Pi / 180
		pts = append(pts, [2]float64{cx + r*math.Cos(t), cy - r*math.Sin(t)})
	}
	stroke(img, pts, w, white)
	end := pts[len(pts)-1]
	stroke(img, [][2]float64{{end[0] - r*0.55, end[1] - r*0.05}, end, {end[0] - r*0.05, end[1] - r*0.6}}, w, white)
}

// drawText — tekst wyśrodkowany pionowo względem cy.
func drawText(img *image.RGBA, f font.Face, s string, x, cy float64, c color.RGBA) {
	m := f.Metrics()
	d := font.Drawer{Dst: img, Src: image.NewUniform(c), Face: f}
	d.Dot = fixed.P(int(math.Round(x)), int(math.Round(cy+float64(m.Ascent-m.Descent)/128)))
	d.DrawString(s)
}

// drawTextTop — tekst od górnej krawędzi y.
func drawTextTop(img *image.RGBA, f font.Face, s string, x, y float64, c color.RGBA) {
	m := f.Metrics()
	d := font.Drawer{Dst: img, Src: image.NewUniform(c), Face: f}
	d.Dot = fixed.P(int(math.Round(x)), int(math.Round(y))+m.Ascent.Ceil())
	d.DrawString(s)
}
