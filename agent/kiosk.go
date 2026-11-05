package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// ---------- zrzut ekranu (jednorazowy, np. miniatury kiosków) ----------

const (
	snapshotDefaultWidth = 640
	snapshotMaxWidth     = 1920
	snapshotTimeout      = 20 * time.Second
	snapshotJPEGQuality  = 72
)

// runDesktopSnapshot — tryb pomocnika „desktop-helper snapshot <szerokość>”: przechwytuje główny monitor,
// zmniejsza obraz i wysyła jeden komunikat (F = JPEG albo L = błąd), po czym kończy pracę.
func runDesktopSnapshot(maxW int) int {
	runtime.LockOSThread()
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()
	fail := func(msg string) int {
		_ = writeMsg(out, msgLog, []byte(msg))
		return 1
	}
	be, err := newDesktopBackend(false)
	if err != nil {
		return fail("ekran niedostępny: " + err.Error())
	}
	defer be.close()
	mons, _ := be.monitors()
	if len(mons) == 0 {
		return fail("brak monitora")
	}
	mon := mons[0]
	for _, m := range mons {
		if m.Primary {
			mon = m
			break
		}
	}
	// przechwytywanie strumieniowe (ScreenCaptureKit, DXGI) oddaje pierwszą klatkę z małym opóźnieniem
	var bgra []byte
	var w, h int
	for deadline := time.Now().Add(3 * time.Second); ; {
		bgra, w, h, err = be.capture(mon)
		if !errors.Is(err, errNoChange) || time.Now().After(deadline) {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if errors.Is(err, errNoChange) {
		return fail("przechwytywanie: brak obrazu (brak zgody na nagrywanie ekranu?)")
	}
	if err != nil {
		return fail("przechwytywanie: " + err.Error())
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, downscaleBGRA(bgra, w, h, maxW), &jpeg.Options{Quality: snapshotJPEGQuality}); err != nil {
		return fail("kodowanie: " + err.Error())
	}
	if err := writeMsg(out, msgFrame, buf.Bytes()); err != nil {
		return 1
	}
	return 0
}

// downscaleBGRA zmniejsza obraz do szerokości maxW, uśredniając bloki pikseli (czytelny tekst na miniaturze).
func downscaleBGRA(bgra []byte, w, h, maxW int) *image.RGBA {
	ow, oh := w, h
	if maxW > 0 && w > maxW {
		ow = maxW
		oh = max(1, h*maxW/w)
	}
	img := image.NewRGBA(image.Rect(0, 0, ow, oh))
	for oy := range oh {
		y0 := oy * h / oh
		y1 := max(y0+1, (oy+1)*h/oh)
		for ox := range ow {
			x0 := ox * w / ow
			x1 := max(x0+1, (ox+1)*w/ow)
			var r, g, b, n int
			for y := y0; y < y1; y++ {
				i := (y*w + x0) * 4
				for x := x0; x < x1; x++ {
					b += int(bgra[i])
					g += int(bgra[i+1])
					r += int(bgra[i+2])
					n++
					i += 4
				}
			}
			d := oy*img.Stride + ox*4
			img.Pix[d], img.Pix[d+1], img.Pix[d+2], img.Pix[d+3] = uint8(r/n), uint8(g/n), uint8(b/n), 255
		}
	}
	return img
}

func handleScreenCapture(ctx context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		MaxWidth int `json:"maxWidth"`
	}](data)
	if err != nil {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie zrzutu ekranu")
	}
	maxW := req.MaxWidth
	if maxW <= 0 {
		maxW = snapshotDefaultWidth
	}
	maxW = min(max(maxW, 160), snapshotMaxWidth)

	proc, err := spawnDesktopHelper("snapshot", strconv.Itoa(maxW))
	if err != nil {
		return nil, protoErr("helper", "nie można uruchomić przechwytywania ekranu: %v", err)
	}
	// pomocnik kończy pracę sam; zamykamy jego potoki i odbieramy proces (bez wycieku uchwytów)
	defer func() {
		proc.kill()
		if c, ok := proc.stdout().(io.Closer); ok {
			_ = c.Close()
		}
		go proc.wait()
	}()

	type result struct {
		typ byte
		p   []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		typ, p, err := readMsg(bufio.NewReader(proc.stdout()))
		ch <- result{typ, p, err}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(snapshotTimeout):
		return nil, protoErr("timeout", "zrzut ekranu trwał zbyt długo")
	case r := <-ch:
		if r.err != nil {
			return nil, protoErr("capture_failed", "zrzut ekranu nie powiódł się: %v", r.err)
		}
		if r.typ != msgFrame {
			return nil, protoErr("capture_failed", "zrzut ekranu nie powiódł się: %s", string(r.p))
		}
		cfg, _ := jpeg.DecodeConfig(bytes.NewReader(r.p))
		return map[string]any{"jpeg": base64.StdEncoding.EncodeToString(r.p), "w": cfg.Width, "h": cfg.Height, "ts": time.Now().UnixMilli()}, nil
	}
}

// ---------- komunikat na ekranie ----------

func handleScreenMessage(_ context.Context, data json.RawMessage) (any, error) {
	req, err := decode[struct {
		Title   string `json:"title"`
		Text    string `json:"text"`
		Seconds int    `json:"seconds"`
	}](data)
	text := strings.TrimSpace(req.Text)
	if err != nil || text == "" || utf8.RuneCountInString(text) > 500 {
		return nil, protoErr("bad_request", "treść komunikatu: 1–500 znaków")
	}
	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Komunikat"
	}
	if utf8.RuneCountInString(title) > 80 {
		title = string([]rune(title)[:80])
	}
	secs := req.Seconds
	if secs <= 0 {
		secs = 60
	}
	secs = min(max(secs, 5), 3600)
	if err := showScreenMessage(title, text, secs); err != nil {
		return nil, protoErr("message_failed", "nie udało się wyświetlić komunikatu: %v", err)
	}
	return map[string]bool{"ok": true}, nil
}

func init() {
	if desktopSupported() {
		handlers["screen.capture"] = handleScreenCapture
		handlers["screen.message"] = handleScreenMessage
	}
}
