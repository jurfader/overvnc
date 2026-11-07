package main

import (
	"errors"
	"fmt"
	"image"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Telefon przez powłokę Windows — ten sam mechanizm, którym Eksplorator pokazuje telefon w „Ten komputer”
// (urządzenia przenośne WPD: Android w trybie „Przesyłanie plików”, iPhone ze sterownikiem Apple).
// Interfejsy COM wywołujemy ręcznie (bez cgo). Wszystko na jednym wątku STA — IFileOperation tego wymaga.

var (
	ole32                           = windows.NewLazySystemDLL("ole32.dll")
	shell32                         = windows.NewLazySystemDLL("shell32.dll")
	procCoInitializeEx              = ole32.NewProc("CoInitializeEx")
	procCoCreateInstance            = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree               = ole32.NewProc("CoTaskMemFree")
	procSHGetKnownFolderItem        = shell32.NewProc("SHGetKnownFolderItem")
	procSHCreateItemFromParsingName = shell32.NewProc("SHCreateItemFromParsingName")
	procGetObjectW                  = gdi32.NewProc("GetObjectW")
	procGetDIBits                   = gdi32.NewProc("GetDIBits")
	procCreateMutexW                = kernel32.NewProc("CreateMutexW")
)

func mustGUID(s string) windows.GUID {
	g, err := windows.GUIDFromString(s)
	if err != nil {
		panic(err)
	}
	return g
}

var (
	folderComputer       = mustGUID("{0AC0837C-BBF8-452A-850D-79D08E667CA7}") // FOLDERID_ComputerFolder („Ten komputer”)
	iidShellItem         = mustGUID("{43826D1E-E718-42EE-BC55-A1E261C37BFE}")
	iidShellItem2        = mustGUID("{7E9FB0D3-919F-4307-AB2E-9B1860310C93}")
	iidEnumShellItems    = mustGUID("{70629033-E363-4A28-A567-0DB78006E6D7}")
	iidImageFactory      = mustGUID("{BCC18B79-BA16-442F-80C4-8A59C30C463B}")
	bhidEnumItems        = mustGUID("{94F60519-2850-4924-AA5A-D15E84868039}")
	clsidFileOperation   = mustGUID("{3AD05575-8857-4850-9277-11B85BDB8E09}")
	iidFileOperation     = mustGUID("{947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8}")
	fmtStorage           = mustGUID("{B725F130-47EF-101A-A5F1-02608C9EEBAC}")
	fmtPhoto             = mustGUID("{14B81DA1-0135-4D31-96D9-6CBFC9671A99}")
	fmtFileName          = mustGUID("{41CF5AE0-F75A-4806-BD87-59C7D9248EB9}")
	wpdInterface         = "{6ac27878-a6fa-4155-ba85-f98f491d4f33}" // GUID_DEVINTERFACE_WPD w ścieżce urządzenia
	errPhoneItemNotFound = errors.New("zdjęcie nie jest już dostępne — odśwież listę")
)

type propKey struct {
	fmtid windows.GUID
	pid   uint32
}

var (
	pkeySize        = propKey{fmtStorage, 12}
	pkeyDateMod     = propKey{fmtStorage, 14}
	pkeyDateCreated = propKey{fmtStorage, 15}
	pkeyDateTaken   = propKey{fmtPhoto, 36867}
	pkeyFileName    = propKey{fmtFileName, 100}
)

const (
	sigdnNormalDisplay   = 0
	sigdnDesktopAbsParse = 0x80028000
	sfgaoFolder          = 0x20000000
	sfgaoFileSystem      = 0x40000000
	sfgaoStream          = 0x00400000
	siigbfBiggerSizeOK   = 0x1
	siigbfThumbnailOnly  = 0x8
	fofSilent            = 0x0004
	fofRenameOnCollision = 0x0008
	fofNoConfirmation    = 0x0010
	fofNoConfirmMkdir    = 0x0200
	fofNoErrorUI         = 0x0400
)

// ---------- COM: wywołania przez tablicę metod ----------

type comPtr struct{ p unsafe.Pointer }

func (c comPtr) call(idx int, args ...uintptr) uintptr {
	vtbl := *(*unsafe.Pointer)(c.p)
	fn := *(*uintptr)(unsafe.Add(vtbl, idx*int(unsafe.Sizeof(uintptr(0)))))
	r, _, _ := syscall.SyscallN(fn, append([]uintptr{uintptr(c.p)}, args...)...)
	return r
}

func (c comPtr) release() {
	if c.p != nil {
		c.call(2)
	}
}

func (c comPtr) query(iid *windows.GUID) (comPtr, error) {
	var out unsafe.Pointer
	if hr := c.call(0, uintptr(unsafe.Pointer(iid)), uintptr(unsafe.Pointer(&out))); hr != 0 {
		return comPtr{}, hresult("QueryInterface", hr)
	}
	return comPtr{out}, nil
}

func hresult(what string, hr uintptr) error {
	return fmt.Errorf("%s: %s", what, windows.Errno(uint32(hr)).Error())
}

func coString(p unsafe.Pointer) string {
	if p == nil {
		return ""
	}
	defer procCoTaskMemFree.Call(uintptr(p))
	return windows.UTF16PtrToString((*uint16)(p))
}

// shellItem — IShellItem.
type shellItem struct{ comPtr }

func (s shellItem) displayName(sigdn uint32) string {
	var p unsafe.Pointer
	if s.call(5, uintptr(sigdn), uintptr(unsafe.Pointer(&p))) != 0 {
		return ""
	}
	return coString(p)
}

func (s shellItem) attributes(mask uint32) uint32 {
	var a uint32
	s.call(6, uintptr(mask), uintptr(unsafe.Pointer(&a)))
	return a
}

func (s shellItem) isFolder() bool {
	a := s.attributes(sfgaoFolder | sfgaoStream)
	return a&sfgaoFolder != 0 && a&sfgaoStream == 0
}

// children — elementy folderu (każdy trzeba zwolnić).
func (s shellItem) children() ([]shellItem, error) {
	var enum unsafe.Pointer
	if hr := s.call(3, 0, uintptr(unsafe.Pointer(&bhidEnumItems)), uintptr(unsafe.Pointer(&iidEnumShellItems)), uintptr(unsafe.Pointer(&enum))); hr != 0 {
		return nil, hresult("BindToHandler", hr)
	}
	e := comPtr{enum}
	defer e.release()
	var out []shellItem
	batch := make([]unsafe.Pointer, 64)
	for {
		var n uint32
		hr := e.call(3, uintptr(len(batch)), uintptr(unsafe.Pointer(&batch[0])), uintptr(unsafe.Pointer(&n)))
		for i := range int(n) {
			out = append(out, shellItem{comPtr{batch[i]}})
			batch[i] = nil
		}
		if hr != 0 || n == 0 { // S_FALSE = koniec
			break
		}
	}
	return out, nil
}

func releaseAll(items []shellItem) {
	for _, it := range items {
		it.release()
	}
}

// props — nazwa pliku (z rozszerzeniem), data zrobienia / utworzenia i rozmiar (IShellItem2).
func (s shellItem) props() (name string, ts int64, size int64) {
	s2, err := s.query(&iidShellItem2)
	if err != nil {
		return s.displayName(sigdnNormalDisplay), 0, 0
	}
	defer s2.release()
	var p unsafe.Pointer
	if s2.call(17, uintptr(unsafe.Pointer(&pkeyFileName)), uintptr(unsafe.Pointer(&p))) == 0 {
		name = coString(p)
	}
	if name == "" {
		name = s.displayName(sigdnNormalDisplay)
	}
	for _, k := range []*propKey{&pkeyDateTaken, &pkeyDateCreated, &pkeyDateMod} {
		var ft windows.Filetime
		if s2.call(15, uintptr(unsafe.Pointer(k)), uintptr(unsafe.Pointer(&ft))) == 0 && (ft.HighDateTime != 0 || ft.LowDateTime != 0) {
			ts = ft.Nanoseconds() / int64(time.Millisecond)
			break
		}
	}
	var sz uint64
	if s2.call(19, uintptr(unsafe.Pointer(&pkeySize)), uintptr(unsafe.Pointer(&sz))) == 0 {
		size = int64(sz)
	}
	return name, ts, size
}

// thumbnail — miniatura z powłoki (dla telefonu: z urządzenia, bez pobierania całego zdjęcia).
func (s shellItem) thumbnail(size int) (image.Image, error) {
	f, err := s.query(&iidImageFactory)
	if err != nil {
		return nil, err
	}
	defer f.release()
	sz := uintptr(uint32(size)) | uintptr(uint32(size))<<32 // SIZE {cx, cy} przekazywany w jednym rejestrze (amd64, arm64)
	var hbm uintptr
	if hr := f.call(3, sz, siigbfBiggerSizeOK|siigbfThumbnailOnly, uintptr(unsafe.Pointer(&hbm))); hr != 0 {
		return nil, hresult("GetImage", hr)
	}
	defer procDeleteObject.Call(hbm)
	return hbitmapImage(hbm)
}

type bitmapInfo struct {
	size                     uint32
	width, height            int32
	planes, bitCount         uint16
	compression, sizeImage   uint32
	xPels, yPels, used, impo uint32
}

func hbitmapImage(hbm uintptr) (image.Image, error) {
	var bm struct {
		typ, width, height, widthBytes int32
		planes, bitsPixel              uint16
		bits                           uintptr
	}
	if r, _, _ := procGetObjectW.Call(hbm, unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 || bm.width <= 0 || bm.height <= 0 {
		return nil, errors.New("pusta miniatura")
	}
	w, h := int(bm.width), int(bm.height)
	bi := bitmapInfo{size: uint32(unsafe.Sizeof(bitmapInfo{})), width: int32(w), height: -int32(h), planes: 1, bitCount: 32}
	buf := make([]byte, w*h*4)
	dc, _, _ := procGetDC.Call(0)
	defer procReleaseDC.Call(0, dc)
	if r, _, _ := procGetDIBits.Call(dc, hbm, 0, uintptr(h), uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&bi)), 0); r == 0 {
		return nil, errors.New("GetDIBits")
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	opaque := true
	for i := 3; i < len(buf); i += 4 {
		if buf[i] != 0 {
			opaque = false
			break
		}
	}
	for i := 0; i < len(buf); i += 4 {
		a := buf[i+3]
		if opaque {
			a = 255
		}
		// BGRA (przemnożone przez alfę) -> RGBA na białym tle
		inv := 255 - uint16(a)
		img.Pix[i] = uint8(min(255, uint16(buf[i+2])+inv))
		img.Pix[i+1] = uint8(min(255, uint16(buf[i+1])+inv))
		img.Pix[i+2] = uint8(min(255, uint16(buf[i])+inv))
		img.Pix[i+3] = 255
	}
	return img, nil
}

func shellItemFromPath(p string) (shellItem, error) {
	u, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return shellItem{}, err
	}
	var out unsafe.Pointer
	if hr, _, _ := procSHCreateItemFromParsingName.Call(uintptr(unsafe.Pointer(u)), 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&out))); hr != 0 {
		return shellItem{}, hresult("SHCreateItemFromParsingName", hr)
	}
	return shellItem{comPtr{out}}, nil
}

// fileOperation — kopiowanie / usuwanie jednego elementu przez IFileOperation (bez okien dialogowych).
func fileOperation(do func(op comPtr) uintptr) error {
	var out unsafe.Pointer
	if hr, _, _ := procCoCreateInstance.Call(uintptr(unsafe.Pointer(&clsidFileOperation)), 0, 1|4, uintptr(unsafe.Pointer(&iidFileOperation)), uintptr(unsafe.Pointer(&out))); hr != 0 {
		return hresult("FileOperation", hr)
	}
	op := comPtr{out}
	defer op.release()
	op.call(5, fofSilent|fofNoConfirmation|fofNoConfirmMkdir|fofNoErrorUI|fofRenameOnCollision)
	if hr := do(op); hr != 0 {
		return hresult("operacja", hr)
	}
	if hr := op.call(21); hr != 0 { // PerformOperations
		return hresult("PerformOperations", hr)
	}
	var aborted int32
	op.call(22, uintptr(unsafe.Pointer(&aborted)))
	if aborted != 0 {
		return errors.New("operacja przerwana (telefon zablokowany albo odłączony?)")
	}
	return nil
}

// ---------- źródło zdjęć ----------

type shellPhoneSource struct {
	tasks chan func()
	// tylko na wątku COM:
	known   map[string]shellItem
	next    int
	dest    map[string]shellItem
	testDir string // OVERVNC_PHONE_SHELL_TEST: zwykły folder udaje telefon (test kodu powłoki bez telefonu)
	once    sync.Once
}

func newPhoneSource() (phoneSource, error) {
	if d := os.Getenv("OVERVNC_PHONE_TEST_DIR"); d != "" {
		return newPhoneDirSource(d), nil
	}
	s := &shellPhoneSource{tasks: make(chan func()), known: map[string]shellItem{}, dest: map[string]shellItem{}, testDir: os.Getenv("OVERVNC_PHONE_SHELL_TEST")}
	ready := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		if hr, _, _ := procCoInitializeEx.Call(0, 2|4); hr != 0 && hr != 1 { // STA, bez OLE1
			ready <- hresult("CoInitializeEx", hr)
			return
		}
		ready <- nil
		var msg [48]byte
		tick := time.NewTicker(50 * time.Millisecond)
		for {
			select {
			case f, ok := <-s.tasks:
				if !ok {
					return
				}
				f()
			case <-tick.C:
				// wątek STA obsługuje komunikaty (wywołania zwrotne powłoki)
				for {
					if r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&msg[0])), 0, 0, 0, 1); r == 0 {
						break
					}
					procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg[0])))
					procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg[0])))
				}
			}
		}
	}()
	if err := <-ready; err != nil {
		return nil, err
	}
	return s, nil
}

func (s *shellPhoneSource) do(f func() error) error {
	done := make(chan error, 1)
	s.tasks <- func() {
		defer func() {
			if r := recover(); r != nil {
				done <- fmt.Errorf("błąd powłoki: %v", r)
			}
		}()
		done <- f()
	}
	return <-done
}

// deviceItems — telefony podłączone do komputera (elementy „Ten komputer” będące urządzeniami WPD).
func (s *shellPhoneSource) deviceItems() ([]shellItem, error) {
	if s.testDir != "" {
		it, err := shellItemFromPath(s.testDir)
		if err != nil {
			return nil, err
		}
		return []shellItem{it}, nil
	}
	var pc unsafe.Pointer
	if hr, _, _ := procSHGetKnownFolderItem.Call(uintptr(unsafe.Pointer(&folderComputer)), 0, 0, uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&pc))); hr != 0 {
		return nil, hresult("Ten komputer", hr)
	}
	root := shellItem{comPtr{pc}}
	defer root.release()
	all, err := root.children()
	if err != nil {
		return nil, err
	}
	var out []shellItem
	for _, it := range all {
		parse := strings.ToLower(it.displayName(sigdnDesktopAbsParse))
		if strings.Contains(parse, wpdInterface) && it.attributes(sfgaoFileSystem) == 0 {
			out = append(out, it)
		} else {
			it.release()
		}
	}
	return out, nil
}

func (s *shellPhoneSource) devices() ([]phoneDevice, error) {
	var out []phoneDevice
	err := s.do(func() error {
		devs, err := s.deviceItems()
		if err != nil {
			return err
		}
		defer releaseAll(devs)
		for _, d := range devs {
			out = append(out, phoneDevice{ID: d.displayName(sigdnDesktopAbsParse), Name: d.displayName(sigdnNormalDisplay)})
		}
		return nil
	})
	return out, err
}

func (s *shellPhoneSource) items(device string) ([]phoneItem, error) {
	var out []phoneItem
	err := s.do(func() error {
		devs, err := s.deviceItems()
		if err != nil {
			return err
		}
		defer releaseAll(devs)
		var dev shellItem
		for _, d := range devs {
			if d.displayName(sigdnDesktopAbsParse) == device {
				dev = d
			}
		}
		if dev.p == nil {
			return errors.New("telefon został odłączony")
		}
		// nowa lista — poprzednie elementy już niepotrzebne
		for _, it := range s.known {
			it.release()
		}
		s.known = map[string]shellItem{}
		// telefon -> pamięci (wewnętrzna, karta) -> DCIM, Pictures, WhatsApp…
		storages := []shellItem{dev}
		if s.testDir == "" {
			storages, err = dev.children()
			if err != nil {
				return err
			}
			defer releaseAll(storages)
		}
		for _, st := range storages {
			for _, root := range phoneScanRoots {
				folder, ok := s.descend(st, root)
				if !ok {
					continue
				}
				s.walk(folder, root, 0, &out)
				folder.release()
			}
		}
		return nil
	})
	return out, err
}

// descend — podfolder po nazwach (bez rozróżniania wielkości liter); wynik do zwolnienia.
func (s *shellPhoneSource) descend(from shellItem, path []string) (shellItem, bool) {
	cur := from
	cur.call(1) // AddRef — wynik zawsze zwalnia wywołujący
	for _, name := range path {
		kids, err := cur.children()
		cur.release()
		if err != nil {
			return shellItem{}, false
		}
		var found shellItem
		for _, k := range kids {
			if found.p == nil && k.isFolder() && strings.EqualFold(k.displayName(sigdnNormalDisplay), name) {
				found = k
				continue
			}
			k.release()
		}
		if found.p == nil {
			return shellItem{}, false
		}
		cur = found
	}
	return cur, true
}

func (s *shellPhoneSource) walk(folder shellItem, segs []string, depth int, out *[]phoneItem) {
	if depth > 6 {
		return
	}
	kids, err := folder.children()
	if err != nil {
		return
	}
	for _, k := range kids {
		if k.isFolder() {
			name := k.displayName(sigdnNormalDisplay)
			if !phoneSkipDir(name) {
				s.walk(k, append(append([]string{}, segs...), name), depth+1, out)
			}
			k.release()
			continue
		}
		name, ts, size := k.props()
		if !phoneIsMedia(name) {
			k.release()
			continue
		}
		s.next++
		id := fmt.Sprintf("p%d", s.next)
		s.known[id] = k // zostaje do miniatur, kopiowania i usuwania
		*out = append(*out, phoneItem{ID: id, Name: name, TS: ts, Size: size, Video: phoneIsVideo(name), Album: phoneAlbum(segs)})
	}
}

func (s *shellPhoneSource) item(id string) (shellItem, error) {
	it, ok := s.known[id]
	if !ok {
		return shellItem{}, errPhoneItemNotFound
	}
	return it, nil
}

func (s *shellPhoneSource) thumb(id string, size int) ([]byte, error) {
	var out []byte
	err := s.do(func() error {
		it, err := s.item(id)
		if err != nil {
			return err
		}
		img, err := it.thumbnail(size)
		if err != nil {
			return err
		}
		out, err = encodeThumb(img, size)
		return err
	})
	return out, err
}

func (s *shellPhoneSource) destItem(dir string) (shellItem, error) {
	if d, ok := s.dest[dir]; ok {
		return d, nil
	}
	d, err := shellItemFromPath(dir)
	if err == nil {
		s.dest[dir] = d
	}
	return d, err
}

func (s *shellPhoneSource) copyTo(id, destDir string) (string, error) {
	var name string
	err := s.do(func() error {
		it, err := s.item(id)
		if err != nil {
			return err
		}
		dest, err := s.destItem(destDir)
		if err != nil {
			return err
		}
		name, _, _ = it.props()
		return fileOperation(func(op comPtr) uintptr { return op.call(16, uintptr(it.p), uintptr(dest.p), 0, 0) })
	})
	return name, err
}

func (s *shellPhoneSource) remove(id string) error {
	return s.do(func() error {
		it, err := s.item(id)
		if err != nil {
			return err
		}
		if err := fileOperation(func(op comPtr) uintptr { return op.call(18, uintptr(it.p), 0) }); err != nil {
			return err
		}
		it.release()
		delete(s.known, id)
		return nil
	})
}

func (s *shellPhoneSource) close() {
	s.once.Do(func() {
		_ = s.do(func() error {
			for _, it := range s.known {
				it.release()
			}
			for _, d := range s.dest {
				d.release()
			}
			return nil
		})
		close(s.tasks)
	})
}

// ---------- okno, folder, jedna kopia ----------

// phoneBrowser — Edge (jest w każdym Windows 11 i jest dozwolony w trybie kiosku), w razie braku Chrome.
func phoneBrowser() string {
	if phoneBrowserPath != "" && fileExists(phoneBrowserPath) {
		return phoneBrowserPath
	}
	for _, base := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
		for _, rel := range []string{`Microsoft\Edge\Application\msedge.exe`, `Google\Chrome\Application\chrome.exe`} {
			if base == "" {
				continue
			}
			if p := filepath.Join(base, rel); fileExists(p) {
				return p
			}
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func phoneOpenWindow(url string) error {
	return openAppWindow(url, "phone-browser", "--start-maximized")
}

// openAppWindow — okno przeglądarki w trybie aplikacji (bez paska adresu i kart), z osobnym profilem —
// nie miesza się z przeglądarką użytkownika.
func openAppWindow(url, profileName string, extra ...string) error {
	exe := phoneBrowser()
	if exe == "" {
		return exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url).Start()
	}
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "OVERVNC", profileName)
	args := append([]string{"--app=" + url, "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + profile}, extra...)
	return exec.Command(exe, args...).Start()
}

func phoneOpenFolder(dir string) error { return exec.Command("explorer.exe", dir).Start() }

func phoneSingleInstance() (func(), bool) {
	name, _ := windows.UTF16PtrFromString(`Local\OVERVNC-Phone`)
	h, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return func() {}, true
	}
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		windows.CloseHandle(windows.Handle(h))
		return nil, false
	}
	return func() { windows.CloseHandle(windows.Handle(h)) }, true
}
