//go:build windows

package main

import (
	"errors"
	"fmt"
	"time"
	"unsafe"

	d3d "github.com/kirides/go-d3d"
	"github.com/kirides/go-d3d/d3d11"
	"github.com/kirides/go-d3d/dxgi"
)

// Przechwytywanie przez DXGI Desktop Duplication (jak AnyDesk/TeamViewer): obraz kopiuje karta graficzna,
// a gdy ekran się nie zmienia, nic nie jest kopiowane ani kodowane — słaby procesor kiosku odpoczywa.
// Gdy DXGI jest niedostępne (ekran blokady, UAC, stary sterownik, zdalna sesja), przez chwilę działa
// zwykłe przechwytywanie GDI i co kilka sekund następuje próba powrotu do DXGI.

const (
	dxgiRetryAfter    = 5 * time.Second
	dxgiFrameInterval = 33 * time.Millisecond // do ~30 kl./s — DXGI kopiuje tylko przy zmianach
	gdiFrameInterval  = 66 * time.Millisecond // GDI kopiuje cały ekran za każdym razem — ~15 kl./s
)

type dxgiOutputDup struct {
	dup        *dxgi.IDXGIOutputDuplication
	staged     *d3d11.ID3D11Texture2D
	surf       *dxgi.IDXGISurface
	x, y, w, h int
}

func (d *dxgiOutputDup) release() {
	if d.surf != nil {
		d.surf.Release()
	}
	if d.staged != nil {
		d.staged.Release()
	}
	if d.dup != nil {
		d.dup.Release()
	}
}

type dxgiBackend struct {
	*gdiBackend // monitory, wejście, przełączanie pulpitu, rysowanie kursora, zapasowe przechwytywanie
	device      *d3d11.ID3D11Device
	devCtx      *d3d11.ID3D11DeviceContext
	cur         *dxgiOutputDup
	frame       []byte // ostatnia pełna klatka BGRA bez kursora
	have        bool   // frame zawiera obraz z DXGI
	gdiUntil    time.Time
	onGDI       bool // ostatnia klatka z GDI (do komunikatu o przełączeniu)
	force       bool // następna klatka musi zostać wysłana (np. zmiana trybu kursora)
	lastCur     cursorPos
}

type cursorPos struct {
	x, y    int32
	handle  uintptr
	visible bool
}

func newDXGIBackend(g *gdiBackend) (*dxgiBackend, error) {
	dev, ctx, err := d3d11.NewD3D11Device()
	if err != nil {
		return nil, fmt.Errorf("urządzenie D3D11: %w", err)
	}
	if dev == nil || ctx == nil {
		return nil, errors.New("urządzenie D3D11 niedostępne")
	}
	return &dxgiBackend{gdiBackend: g, device: dev, devCtx: ctx}, nil
}

func (b *dxgiBackend) close() {
	b.releaseDevice()
	b.gdiBackend.close()
}

func (b *dxgiBackend) releaseDevice() {
	b.closeDup()
	if b.devCtx != nil {
		b.devCtx.Release()
		b.devCtx = nil
	}
	if b.device != nil {
		b.device.Release()
		b.device = nil
	}
}

// followInputDesktop przełącza wątek na bieżący pulpit wejściowy (ekran blokady, UAC). SetThreadDesktop
// odmawia, gdy wątek ma zasoby okienkowe na starym pulpicie — urządzenie D3D zwalniamy więc najpierw
// i tworzymy ponownie przy następnej klatce.
func (b *dxgiBackend) followInputDesktop() {
	if name := inputDesktopName(); name != "" && name != b.deskName && b.device != nil {
		b.releaseDevice()
	}
	b.switchDesktop()
}

func (b *dxgiBackend) monitors() ([]MonitorInfo, string) {
	b.followInputDesktop()
	return b.gdiBackend.monitors()
}

func (b *dxgiBackend) input(ev InputEvent, m MonitorInfo) error {
	b.followInputDesktop()
	return b.gdiBackend.input(ev, m)
}

func (b *dxgiBackend) closeDup() {
	if b.cur != nil {
		b.cur.release()
		b.cur = nil
	}
	b.have = false
}

func (b *dxgiBackend) interval() time.Duration {
	if b.onGDI {
		return gdiFrameInterval
	}
	return dxgiFrameInterval
}

// invalidate — pełna klatka na żądanie (np. przeglądarka po ponownym połączeniu), także bez zmian na ekranie.
func (b *dxgiBackend) invalidate() { b.force = true }

func (b *dxgiBackend) setCursor(on bool) {
	b.gdiBackend.setCursor(on)
	b.force = true
}

// openDup tworzy duplikację wyjścia karty graficznej odpowiadającego monitorowi m (dopasowanie po współrzędnych).
func (b *dxgiBackend) openDup(m MonitorInfo) error {
	if b.device == nil {
		dev, ctx, err := d3d11.NewD3D11Device()
		if err != nil || dev == nil || ctx == nil {
			return fmt.Errorf("urządzenie D3D11: %v", err)
		}
		b.device, b.devCtx = dev, ctx
	}
	var dev1 *dxgi.IDXGIDevice1
	if hr := d3d.HRESULT(b.device.QueryInterface(dxgi.IID_IDXGIDevice1, &dev1)); hr.Failed() {
		return fmt.Errorf("IDXGIDevice1: %w", hr)
	}
	defer dev1.Release()
	var pAdapter unsafe.Pointer
	if hr := d3d.HRESULT(dev1.GetParent(dxgi.IID_IDXGIAdapter1, &pAdapter)); hr.Failed() {
		return fmt.Errorf("karta graficzna: %w", hr)
	}
	adapter := (*dxgi.IDXGIAdapter1)(pAdapter)
	defer adapter.Release()

	for i := uint32(0); ; i++ {
		var out *dxgi.IDXGIOutput
		if hr := d3d.HRESULT(adapter.EnumOutputs(i, &out)); hr.Failed() {
			return errors.New("monitor nie jest podłączony do tej karty graficznej")
		}
		dup, err := b.duplicateIfMatches(out, dev1, m)
		out.Release()
		if err != nil {
			return err
		}
		if dup != nil {
			b.cur = &dxgiOutputDup{dup: dup, x: m.X, y: m.Y, w: m.W, h: m.H}
			b.have = false
			return nil
		}
	}
}

func (b *dxgiBackend) duplicateIfMatches(out *dxgi.IDXGIOutput, dev1 *dxgi.IDXGIDevice1, m MonitorInfo) (*dxgi.IDXGIOutputDuplication, error) {
	var out5 *dxgi.IDXGIOutput5
	if hr := d3d.HRESULT(out.QueryInterface(dxgi.IID_IDXGIOutput5, &out5)); hr.Failed() {
		return nil, fmt.Errorf("IDXGIOutput5 (wymagany Windows 10 1803+): %w", hr)
	}
	defer out5.Release()
	var desc dxgi.DXGI_OUTPUT_DESC
	if hr := d3d.HRESULT(out5.GetDesc(&desc)); hr.Failed() {
		return nil, fmt.Errorf("opis monitora: %w", hr)
	}
	r := desc.DesktopCoordinates
	if int(r.Left) != m.X || int(r.Top) != m.Y || int(r.Right-r.Left) != m.W || int(r.Bottom-r.Top) != m.H {
		return nil, nil // inny monitor
	}
	var dup *dxgi.IDXGIOutputDuplication
	// proces pomocnika jest „per-monitor DPI aware” — wtedy właściwe jest DuplicateOutput1 (format BGRA)
	hr := d3d.HRESULT(out5.DuplicateOutput1(dev1, 0, []dxgi.DXGI_FORMAT{dxgi.DXGI_FORMAT_B8G8R8A8_UNORM}, &dup))
	if hr.Failed() {
		var out1 *dxgi.IDXGIOutput1
		if hr1 := d3d.HRESULT(out.QueryInterface(dxgi.IID_IDXGIOutput1, &out1)); hr1.Failed() {
			return nil, fmt.Errorf("DuplicateOutput1: %v; IDXGIOutput1: %w", hr, hr1)
		}
		defer out1.Release()
		if hr2 := d3d.HRESULT(out1.DuplicateOutput(dev1, &dup)); hr2.Failed() {
			return nil, fmt.Errorf("DuplicateOutput: %w", hr2)
		}
	}
	return dup, nil
}

// grab pobiera nową klatkę do b.frame. changed=false: obraz się nie zmienił (najwyżej ruch kursora).
func (b *dxgiBackend) grab(m MonitorInfo) (changed bool, err error) {
	d := b.cur
	var info dxgi.DXGI_OUTDUPL_FRAME_INFO
	var res *dxgi.IDXGIResource
	if hr := d3d.HRESULT(d.dup.AcquireNextFrame(0, &info, &res)); hr.Failed() {
		if hr == d3d.DXGI_ERROR_WAIT_TIMEOUT {
			return false, nil
		}
		return false, fmt.Errorf("AcquireNextFrame: %w", hr)
	}
	defer d.dup.ReleaseFrame()
	defer res.Release()
	if info.AccumulatedFrames == 0 {
		return false, nil // zmienił się tylko kursor
	}
	var tex *d3d11.ID3D11Texture2D
	if hr := d3d.HRESULT(res.QueryInterface(d3d11.IID_ID3D11Texture2D, &tex)); hr.Failed() {
		return false, fmt.Errorf("tekstura pulpitu: %w", hr)
	}
	defer tex.Release()

	if d.staged == nil {
		var desc d3d11.D3D11_TEXTURE2D_DESC
		if hr := d3d.HRESULT(tex.GetDesc(&desc)); hr.Failed() {
			return false, fmt.Errorf("opis tekstury: %w", hr)
		}
		if int(desc.Width) != m.W || int(desc.Height) != m.H {
			return false, fmt.Errorf("obraz %d×%d zamiast %d×%d (obrócony ekran?)", desc.Width, desc.Height, m.W, m.H)
		}
		desc.Usage = d3d11.D3D11_USAGE_STAGING
		desc.CPUAccessFlags = d3d11.D3D11_CPU_ACCESS_READ
		desc.BindFlags = 0
		desc.MipLevels = 1
		desc.ArraySize = 1
		desc.MiscFlags = 0
		desc.SampleDesc.Count = 1
		desc.SampleDesc.Quality = 0
		if hr := d3d.HRESULT(b.device.CreateTexture2D(&desc, &d.staged)); hr.Failed() {
			return false, fmt.Errorf("tekstura pomocnicza: %w", hr)
		}
		if hr := d3d.HRESULT(d.staged.QueryInterface(dxgi.IID_IDXGISurface, &d.surf)); hr.Failed() {
			return false, fmt.Errorf("powierzchnia: %w", hr)
		}
	}
	// zawsze pełna kopia po stronie karty graficznej — obraz kompletny także po ponownym utworzeniu duplikacji
	b.devCtx.CopyResource2D(d.staged, tex)
	var mr dxgi.DXGI_MAPPED_RECT
	if hr := d3d.HRESULT(d.surf.Map(&mr, dxgi.DXGI_MAP_READ)); hr.Failed() {
		return false, fmt.Errorf("odczyt obrazu: %w", hr)
	}
	defer d.surf.Unmap()
	row := m.W * 4
	pitch := int(mr.Pitch)
	if pitch < row {
		return false, fmt.Errorf("nieprawidłowy rozmiar wiersza %d", pitch)
	}
	if len(b.frame) != row*m.H {
		b.frame = make([]byte, row*m.H)
	}
	src := unsafe.Slice((*byte)(mr.PBits), pitch*(m.H-1)+row)
	for y := range m.H {
		copy(b.frame[y*row:(y+1)*row], src[y*pitch:y*pitch+row])
	}
	return true, nil
}

func (b *dxgiBackend) capture(m MonitorInfo) ([]byte, int, int, error) {
	b.followInputDesktop()
	if time.Now().Before(b.gdiUntil) {
		return b.gdiCapture(m)
	}
	if b.cur == nil || b.cur.x != m.X || b.cur.y != m.Y || b.cur.w != m.W || b.cur.h != m.H {
		b.closeDup()
		if err := b.openDup(m); err != nil {
			return b.fallback(m, err)
		}
	}
	changed, err := b.grab(m)
	if err != nil {
		b.closeDup() // np. DXGI_ERROR_ACCESS_LOST — ekran blokady, UAC, zmiana rozdzielczości
		return b.fallback(m, err)
	}
	if b.onGDI {
		b.onGDI = false
		helperLogHook("przechwytywanie ekranu: DXGI (karta graficzna)")
	}
	if !changed {
		if !b.have {
			// pierwsza klatka po utworzeniu duplikacji nie przyszła — obraz startowy z GDI
			return b.gdiBackend.capture(m)
		}
		if !b.force && !(b.drawCursorOn && b.cursorMoved()) {
			return nil, 0, 0, errNoChange
		}
	} else {
		b.have = true
	}
	b.force = false
	return b.compose(m)
}

func (b *dxgiBackend) gdiCapture(m MonitorInfo) ([]byte, int, int, error) {
	b.onGDI = true
	return b.gdiBackend.capture(m)
}

func (b *dxgiBackend) fallback(m MonitorInfo, err error) ([]byte, int, int, error) {
	if !b.onGDI {
		helperLogHook(fmt.Sprintf("przechwytywanie ekranu: DXGI niedostępne (%v) — tymczasowo GDI", err))
	}
	b.gdiUntil = time.Now().Add(dxgiRetryAfter)
	return b.gdiCapture(m)
}

// compose zwraca klatkę do wysłania: obraz z DXGI, z kursorem dorysowanym przez GDI, gdy jest włączony.
func (b *dxgiBackend) compose(m MonitorInfo) ([]byte, int, int, error) {
	n := m.W * m.H * 4
	if !b.drawCursorOn {
		return b.frame, m.W, m.H, nil
	}
	if err := b.ensureBitmap(m.W, m.H); err != nil {
		return nil, 0, 0, err
	}
	copy(unsafe.Slice((*byte)(b.bits), n), b.frame)
	b.drawCursor(m)
	if len(b.out) != n {
		b.out = make([]byte, n)
	}
	copy(b.out, unsafe.Slice((*byte)(b.bits), n))
	b.lastCur = cursorNow()
	return b.out, m.W, m.H, nil
}

func (b *dxgiBackend) cursorMoved() bool {
	return cursorNow() != b.lastCur
}

func cursorNow() cursorPos {
	ci := cursorInfo{}
	ci.cbSize = uint32(unsafe.Sizeof(ci))
	if r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&ci))); r == 0 {
		return cursorPos{}
	}
	return cursorPos{x: ci.x, y: ci.y, handle: ci.hCursor, visible: ci.flags&1 != 0}
}
