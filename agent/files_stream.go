package main

import (
	"archive/zip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	chunkSize   = 64 * 1024
	flowWindow  = 2 << 20 // maks. 2 MB wysłane bez potwierdzenia
	uploadQueue = 64      // okno serwera 2 MB / 64 KB = 32 kawałki — z zapasem
	commitWait  = 2 * time.Minute
	partSuffix  = ".overvnc-part-"
)

// ---------- pobieranie: agent -> serwer ----------

// sender wysyła dane kanałem z kontrolą przepływu: nie więcej niż flowWindow bez potwierdzenia.
type sender struct {
	sess     *sessionIO
	ch       uint32
	mu       sync.Mutex
	cond     *sync.Cond
	inflight int
	closed   bool
	sent     int64
}

func newSender(sess *sessionIO, ch uint32) *sender {
	s := &sender{sess: sess, ch: ch}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *sender) ack(n int) {
	s.mu.Lock()
	s.inflight = max(0, s.inflight-n)
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *sender) write([]byte) error { return nil } // pobieranie nie przyjmuje danych od serwera

func (s *sender) close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cond.Broadcast()
}

var errChannelClosed = errors.New("kanał zamknięty")

// Write implementuje io.Writer — dzięki temu io.Copy i zip.Writer piszą prosto do kanału.
func (s *sender) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), chunkSize)
		s.mu.Lock()
		for s.inflight >= flowWindow && !s.closed {
			s.cond.Wait()
		}
		if s.closed {
			s.mu.Unlock()
			return written, errChannelClosed
		}
		s.inflight += n
		s.mu.Unlock()
		if err := s.sess.writeBinary(encodeFrame(frameData, s.ch, p[:n])); err != nil {
			return written, err
		}
		s.sent += int64(n)
		written += n
		p = p[n:]
	}
	return written, nil
}

type fsReadReq struct {
	Channel uint32 `json:"channel"`
	Path    string `json:"path"`
	Zip     bool   `json:"zip"`
}

func handleFsRead(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	req, err := decode[fsReadReq](data)
	if err != nil || req.Channel == 0 {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	p, err := cleanPath(req.Path)
	if err != nil {
		return nil, err
	}
	fi, err := os.Stat(p)
	if err != nil {
		return nil, fsErr(err, p)
	}
	asZip := req.Zip || fi.IsDir()
	var f *os.File
	if !asZip {
		if f, err = os.Open(p); err != nil {
			return nil, fsErr(err, p)
		}
	}

	snd := newSender(sess, req.Channel)
	if err := sess.channels.add(req.Channel, snd); err != nil {
		if f != nil {
			f.Close()
		}
		return nil, err
	}

	go func() {
		var err error
		if asZip {
			err = zipTree(p, snd)
		} else {
			_, err = io.Copy(snd, f)
			f.Close()
		}
		sess.channels.remove(req.Channel)
		ev := map[string]any{"channel": req.Channel, "exitCode": 0, "bytes": snd.sent}
		if err != nil {
			if errors.Is(err, errChannelClosed) {
				return // przerwane przez serwer/przeglądarkę — nikt już nie czeka na zdarzenie
			}
			ev["exitCode"], ev["error"] = 1, err.Error()
		}
		_ = sess.event("channel.closed", ev)
	}()

	name := filepath.Base(p)
	size := fi.Size()
	if asZip {
		name, size = name+".zip", -1
		if filepath.Dir(p) == p { // katalog główny dysku, np. "/" albo "C:\"
			name = "dysk.zip"
		}
	}
	return map[string]any{"name": name, "size": size, "modified": fi.ModTime().UnixMilli()}, nil
}

// zipTree pakuje katalog (lub plik) w locie; pliki niedostępne są pomijane, zamiast przerywać całość.
func zipTree(root string, w io.Writer) error {
	zw := zip.NewWriter(w)
	base := filepath.Dir(root)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || (!d.IsDir() && !d.Type().IsRegular()) {
			return nil
		}
		rel, _ := filepath.Rel(base, path)
		name := filepath.ToSlash(rel)
		info, err := d.Info()
		if err != nil {
			return nil
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return nil
		}
		hdr.Name = name
		if d.IsDir() {
			hdr.Name += "/"
			_, err = zw.CreateHeader(hdr)
			return err
		}
		hdr.Method = zip.Deflate
		src, err := os.Open(path)
		if err != nil {
			return nil // brak dostępu do pojedynczego pliku — pomijamy
		}
		defer src.Close()
		dst, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		_, err = io.Copy(dst, src)
		return err
	})
	if err != nil {
		return err
	}
	return zw.Close()
}

// ---------- wysyłanie: serwer -> agent ----------

type receiver struct {
	sess      *sessionIO
	ch        uint32
	target    string
	tmp       *os.File
	expected  int64
	queue     chan []byte
	done      chan struct{}
	mu        sync.Mutex
	written   int64
	err       error
	committed bool
	once      sync.Once
}

func (r *receiver) write(p []byte) error {
	select {
	case r.queue <- p:
		return nil
	case <-r.done:
		return errChannelClosed
	default:
		r.fail(errors.New("serwer przekroczył okno przesyłania"))
		return errors.New("kolejka pełna")
	}
}

// loop zapisuje kawałki na dysk i potwierdza każdy dopiero po zapisie.
func (r *receiver) loop() {
	for {
		select {
		case <-r.done:
			return
		case b := <-r.queue:
			if _, err := r.tmp.Write(b); err != nil {
				r.fail(err)
				return
			}
			r.mu.Lock()
			r.written += int64(len(b))
			over := r.written > r.expected
			r.mu.Unlock()
			if over {
				r.fail(errors.New("otrzymano więcej danych niż zapowiedziano"))
				return
			}
			_ = r.sess.writeBinary(encodeAck(r.ch, len(b)))
		}
	}
}

func (r *receiver) fail(err error) {
	r.mu.Lock()
	if r.err == nil {
		r.err = err
	}
	r.mu.Unlock()
	r.sess.channels.remove(r.ch)
	r.close()
	_ = r.sess.event("channel.closed", map[string]any{"channel": r.ch, "exitCode": 1, "error": err.Error()})
}

// close — bez zatwierdzenia plik tymczasowy jest usuwany (przerwane wysyłanie nie zostawia śmieci).
func (r *receiver) close() {
	r.once.Do(func() {
		close(r.done)
		r.tmp.Close()
		r.mu.Lock()
		committed := r.committed
		r.mu.Unlock()
		if !committed {
			_ = os.Remove(r.tmp.Name())
		}
	})
}

func handleFsWrite(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	req, err := decode[struct {
		Channel   uint32 `json:"channel"`
		Dir       string `json:"dir"`
		Name      string `json:"name"`
		Size      int64  `json:"size"`
		Overwrite bool   `json:"overwrite"`
	}](data)
	if err != nil || req.Channel == 0 || req.Size < 0 {
		return nil, protoErr("bad_request", "nieprawidłowe żądanie")
	}
	if !validName(req.Name) {
		return nil, protoErr("bad_name", "nieprawidłowa nazwa pliku: %q", req.Name)
	}
	dir, err := cleanPath(req.Dir)
	if err != nil {
		return nil, err
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		return nil, protoErr("not_found", "katalog docelowy nie istnieje: %s", dir)
	}
	target := filepath.Join(dir, req.Name)
	if fi, err := os.Lstat(target); err == nil {
		if fi.IsDir() {
			return nil, protoErr("exists", "istnieje katalog o tej nazwie: %s", req.Name)
		}
		if !req.Overwrite {
			return nil, protoErr("exists", "plik %s już istnieje", req.Name)
		}
	}
	if free := freeSpace(dir); free > 0 && uint64(req.Size) > free {
		return nil, protoErr("no_space", "za mało miejsca na dysku (wolne %d MB)", free>>20)
	}
	var rnd [6]byte
	_, _ = rand.Read(rnd[:])
	tmp, err := os.OpenFile(filepath.Join(dir, "."+req.Name+partSuffix+hex.EncodeToString(rnd[:])), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fsErr(err, dir)
	}
	r := &receiver{sess: sess, ch: req.Channel, target: target, tmp: tmp, expected: req.Size, queue: make(chan []byte, uploadQueue), done: make(chan struct{})}
	if err := sess.channels.add(req.Channel, r); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return nil, err
	}
	go r.loop()
	return map[string]any{"path": target}, nil
}

// handleFsCommit — serwer wysłał wszystkie dane; czekamy na zapis, synchronizujemy dysk i podmieniamy plik.
func handleFsCommit(ctx context.Context, data json.RawMessage) (any, error) {
	sess, err := sessionFrom(ctx)
	if err != nil {
		return nil, err
	}
	req, err := decode[struct {
		Channel uint32 `json:"channel"`
		Size    int64  `json:"size"`
	}](data)
	if err != nil {
		return nil, err
	}
	r, ok := sess.channels.get(req.Channel).(*receiver)
	if !ok {
		return nil, protoErr("no_channel", "przesyłanie nie istnieje lub zostało przerwane")
	}
	deadline := time.Now().Add(commitWait)
	for {
		r.mu.Lock()
		written, ferr := r.written, r.err
		r.mu.Unlock()
		if ferr != nil {
			return nil, protoErr("write_failed", "zapis nie powiódł się: %v", ferr)
		}
		if written == req.Size && req.Size == r.expected {
			break
		}
		if written > req.Size || time.Now().After(deadline) {
			r.fail(errors.New("niezgodny rozmiar pliku"))
			return nil, protoErr("size_mismatch", "zapisano %d z %d bajtów", written, req.Size)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err := r.tmp.Sync(); err != nil {
		r.fail(err)
		return nil, fsErr(err, r.target)
	}
	// plik trzeba zamknąć PRZED rename — Windows nie pozwala przemianować otwartego pliku
	tmpName := r.tmp.Name()
	r.mu.Lock()
	r.committed = true // close() nie usunie już pliku tymczasowego
	r.mu.Unlock()
	sess.channels.remove(req.Channel)
	r.close()
	if err := os.Rename(tmpName, r.target); err != nil {
		_ = os.Remove(tmpName)
		return nil, fsErr(err, r.target)
	}
	return map[string]any{"path": r.target, "size": req.Size}, nil
}

func init() {
	handlers["fs.read"] = handleFsRead
	handlers["fs.write"] = handleFsWrite
	handlers["fs.commit"] = handleFsCommit
}
