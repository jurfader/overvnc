package main

import (
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"image"
	"image/draw"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"

	xdraw "golang.org/x/image/draw"
)

// phoneDirSource — „telefon” z folderu (OVERVNC_PHONE_TEST_DIR): każdy podfolder to jedno urządzenie
// z układem jak w telefonie (DCIM/Camera, Pictures/Screenshots…). Testy i praca nad interfejsem
// bez prawdziwego telefonu.
type phoneDirSource struct {
	root string
	mu   sync.Mutex
	ids  map[string]string // id -> ścieżka
}

func newPhoneDirSource(root string) *phoneDirSource {
	return &phoneDirSource{root: root, ids: map[string]string{}}
}

func (s *phoneDirSource) devices() ([]phoneDevice, error) {
	ents, err := os.ReadDir(s.root)
	if err != nil {
		return nil, err
	}
	var out []phoneDevice
	for _, e := range ents {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, phoneDevice{ID: e.Name(), Name: e.Name()})
		}
	}
	return out, nil
}

func (s *phoneDirSource) items(device string) ([]phoneItem, error) {
	if device == "" || strings.ContainsAny(device, `/\`) || device == ".." {
		return nil, errors.New("nieznany telefon")
	}
	base := filepath.Join(s.root, device)
	var out []phoneItem
	for _, root := range phoneScanRoots {
		dir := filepath.Join(append([]string{base}, root...)...)
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if p != dir && phoneSkipDir(d.Name()) {
					return filepath.SkipDir
				}
				return nil
			}
			if !phoneIsMedia(d.Name()) {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(base, filepath.Dir(p))
			sum := sha1.Sum([]byte(p))
			id := hex.EncodeToString(sum[:8])
			s.mu.Lock()
			s.ids[id] = p
			s.mu.Unlock()
			out = append(out, phoneItem{
				ID: id, Name: d.Name(), TS: info.ModTime().UnixMilli(), Size: info.Size(),
				Video: phoneIsVideo(d.Name()), Album: phoneAlbum(strings.Split(filepath.ToSlash(rel), "/")),
			})
			return nil
		})
	}
	return out, nil
}

func (s *phoneDirSource) path(id string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.ids[id]
	if !ok {
		return "", errors.New("zdjęcie nie jest już dostępne — odśwież listę")
	}
	return p, nil
}

func (s *phoneDirSource) thumb(id string, size int) ([]byte, error) {
	p, err := s.path(id)
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	return encodeThumb(img, size)
}

// encodeThumb — pomniejszenie do size×size (z zachowaniem proporcji) na białym tle, JPEG.
func encodeThumb(img image.Image, size int) ([]byte, error) {
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > size || h > size {
		if w >= h {
			h, w = max(1, h*size/w), size
		} else {
			w, h = max(1, w*size/h), size
		}
	}
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(dst, dst.Bounds(), image.White, image.Point{}, draw.Src)
	xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 82}); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func (s *phoneDirSource) copyTo(id, destDir string) (string, error) {
	p, err := s.path(id)
	if err != nil {
		return "", err
	}
	in, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer in.Close()
	name := uniqueName(destDir, filepath.Base(p))
	out, err := os.OpenFile(filepath.Join(destDir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		_ = os.Remove(out.Name())
		return "", err
	}
	return name, out.Close()
}

func (s *phoneDirSource) remove(id string) error {
	p, err := s.path(id)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.ids, id)
	s.mu.Unlock()
	return nil
}

func (s *phoneDirSource) close() {}
