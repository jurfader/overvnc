package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

func writeJPEG(t *testing.T, p string, w, h int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for i := range img.Pix {
		img.Pix[i] = byte(i)
	}
	img.Set(0, 0, color.RGBA{255, 0, 0, 255})
	var b bytes.Buffer
	_ = jpeg.Encode(&b, img, nil)
	if err := os.WriteFile(p, b.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestPhoneApp(t *testing.T) {
	root := t.TempDir()
	dev := filepath.Join(root, "Galaxy S21")
	writeJPEG(t, filepath.Join(dev, "DCIM", "Camera", "IMG_1.jpg"), 400, 300)
	writeJPEG(t, filepath.Join(dev, "DCIM", ".thumbnails", "x.jpg"), 10, 10) // pomijane
	writeJPEG(t, filepath.Join(dev, "Pictures", "Screenshots", "Screenshot_1.jpg"), 300, 600)
	writeJPEG(t, filepath.Join(dev, "Android", "media", "com.whatsapp", "WhatsApp", "Media", "WhatsApp Images", "IMG-WA0001.jpg"), 200, 200)
	writeJPEG(t, filepath.Join(dev, "Android", "media", "com.whatsapp", "WhatsApp", "Media", "WhatsApp Images", "Sent", "IMG-WA0002.jpg"), 200, 200) // wysłane — pomijane
	_ = os.WriteFile(filepath.Join(dev, "DCIM", "Camera", "notatka.txt"), []byte("x"), 0o644)
	_ = os.WriteFile(filepath.Join(dev, "DCIM", "Camera", "VID_1.mp4"), []byte("film"), 0o644)
	old := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(filepath.Join(dev, "DCIM", "Camera", "IMG_1.jpg"), old, old)

	dest := t.TempDir()
	writeJPEG(t, filepath.Join(dest, "IMG_1.jpg"), 10, 10) // kolizja nazw w Pobranych
	app := newPhoneApp(newPhoneDirSource(root), dest)
	srv := httptest.NewServer(app.handler())
	defer srv.Close()

	get := func(path string, v any) int {
		t.Helper()
		sep := "?"
		if strings.Contains(path, "?") {
			sep = "&"
		}
		r, err := http.Get(srv.URL + path + sep + "t=" + app.token)
		if err != nil {
			t.Fatal(err)
		}
		defer r.Body.Close()
		if v != nil {
			_ = json.NewDecoder(r.Body).Decode(v)
		}
		return r.StatusCode
	}
	post := func(path string, ids []string) {
		t.Helper()
		b, _ := json.Marshal(map[string]any{"ids": ids})
		r, err := http.Post(srv.URL+path+"?t="+app.token, "application/json", bytes.NewReader(b))
		if err != nil || r.StatusCode != 200 {
			t.Fatalf("%s: %v %v", path, err, r.Status)
		}
		r.Body.Close()
	}
	wait := func() phoneOp {
		t.Helper()
		for range 200 {
			var r struct{ Op *phoneOp }
			get("/api/op", &r)
			if r.Op != nil && r.Op.Finished {
				return *r.Op
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("operacja się nie skończyła")
		return phoneOp{}
	}

	// bez tokenu — nic
	if r, _ := http.Get(srv.URL + "/api/devices"); r.StatusCode != http.StatusForbidden {
		t.Fatalf("API bez tokenu: %d", r.StatusCode)
	}
	// interfejs dostępny (bez tokenu — to tylko pliki strony)
	if r, _ := http.Get(srv.URL + "/"); r.StatusCode != 200 {
		t.Fatalf("strona: %d", r.StatusCode)
	}

	var devs struct{ Devices []phoneDevice }
	get("/api/devices", &devs)
	if len(devs.Devices) != 1 || devs.Devices[0].Name != "Galaxy S21" {
		t.Fatalf("telefony: %+v", devs)
	}
	var list struct{ Items []phoneItem }
	get("/api/items?device=Galaxy%20S21", &list)
	got := map[string]string{}
	for _, it := range list.Items {
		got[it.Name] = it.Album
	}
	want := map[string]string{"IMG_1.jpg": "Aparat", "VID_1.mp4": "Aparat", "Screenshot_1.jpg": "Zrzuty ekranu", "IMG-WA0001.jpg": "WhatsApp"}
	if len(got) != len(want) {
		t.Fatalf("zdjęcia: %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("%s: album %q, oczekiwano %q (%v)", k, got[k], v, got)
		}
	}
	if list.Items[len(list.Items)-1].Name != "IMG_1.jpg" {
		t.Fatalf("najnowsze pierwsze — najstarsze na końcu: %+v", list.Items)
	}
	byName := map[string]phoneItem{}
	for _, it := range list.Items {
		byName[it.Name] = it
	}
	if !byName["VID_1.mp4"].Video {
		t.Fatal("film nie oznaczony")
	}
	if get("/api/items?device=..", nil) == 200 {
		t.Fatal("wyjście poza folder testowy")
	}

	// miniatura
	r, _ := http.Get(srv.URL + "/api/thumb?id=" + byName["IMG_1.jpg"].ID + "&t=" + app.token)
	img, err := jpeg.Decode(r.Body)
	r.Body.Close()
	if err != nil || img.Bounds().Dx() != 320 || img.Bounds().Dy() != 240 {
		t.Fatalf("miniatura: %v %v", err, img)
	}

	// kopiowanie: kolizja nazw -> „IMG_1 (2).jpg”
	post("/api/copy", []string{byName["IMG_1.jpg"].ID, byName["IMG-WA0001.jpg"].ID})
	if op := wait(); op.Done != 2 || op.Failed != 0 || op.Dest != dest {
		t.Fatalf("kopiowanie: %+v", op)
	}
	names, _ := filepath.Glob(filepath.Join(dest, "*"))
	for i := range names {
		names[i] = filepath.Base(names[i])
	}
	sort.Strings(names)
	if strings.Join(names, "|") != "IMG-WA0001.jpg|IMG_1 (2).jpg|IMG_1.jpg" {
		t.Fatalf("Pobrane: %v", names)
	}

	// usuwanie z telefonu
	post("/api/delete", []string{byName["Screenshot_1.jpg"].ID})
	if op := wait(); op.Done != 1 || op.Failed != 0 {
		t.Fatalf("usuwanie: %+v", op)
	}
	if _, err := os.Stat(filepath.Join(dev, "Pictures", "Screenshots", "Screenshot_1.jpg")); !os.IsNotExist(err) {
		t.Fatal("zdjęcie nie zostało usunięte z telefonu")
	}
}

func TestPhoneAlbum(t *testing.T) {
	for in, want := range map[string]string{
		"DCIM/Camera":                    "Aparat",
		"DCIM/100APPLE":                  "Aparat",
		"Pictures/Screenshots":           "Zrzuty ekranu",
		"DCIM/Screenshots":               "Zrzuty ekranu",
		"Pictures/Messenger":             "Messenger",
		"WhatsApp/Media/WhatsApp Images": "WhatsApp",
		"Download":                       "Pobrane",
		"Pictures/Wakacje":               "Wakacje",
	} {
		if got := phoneAlbum(strings.Split(in, "/")); got != want {
			t.Errorf("%s: %q, oczekiwano %q", in, got, want)
		}
	}
}
