package main

import (
	"encoding/json"
	"math"
	"regexp"
	"sync"
	"sync/atomic"

	"github.com/pion/webrtc/v4"
)

// Bezpośrednie połączenie z pulpitem (WebRTC). Przeglądarka wysyła ofertę i kandydatów ICE przez
// zwykły kanał pulpitu (serwer je przekazuje), agent odpowiada wiadomościami 'R'. Gdy kanał danych
// „desk” jest otwarty, klatki i informacje płyną nim zamiast przez serwer, a przeglądarka wysyła nim
// ruch myszy, klawisze i potwierdzenia klatek. Rzadkie akcje (wklejanie, Ctrl+Alt+Del, przejęcie
// sterowania, ustawienia) zostają na drodze przez serwer — tam są sprawdzane i zapisywane w dzienniku.
// Zerwanie połączenia bezpośredniego = powrót do drogi przez serwer bez przerywania sesji.

// iceServer — serwery STUN/TURN od serwera OVERVNC (TURN z jednorazowym hasłem na sesję).
type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// rtcChunk — największy kawałek wiadomości w kanale danych (przeglądarki przyjmują do 256 KB,
// mniejsze kawałki nie blokują kanału przy dużych klatkach).
const rtcChunk = 64 << 10

type rtcSignal struct {
	T    string                     `json:"t"`
	SDP  *webrtc.SessionDescription `json:"sdp,omitempty"`
	Cand *webrtc.ICECandidateInit   `json:"cand,omitempty"`
}

type rtcPeer struct {
	pc      *webrtc.PeerConnection
	dc      atomic.Pointer[webrtc.DataChannel] // otwarty kanał „desk” (nil = droga przez serwer)
	sendMu  sync.Mutex
	pending []webrtc.ICECandidateInit // kandydaci przed opisem sesji
	closed  atomic.Bool
}

// send wysyła wiadomość [typ][dane] kawałkami: [0 = ciąg dalszy | 1 = koniec][…].
func (r *rtcPeer) send(msg []byte) bool {
	dc := r.dc.Load()
	if dc == nil {
		return false
	}
	r.sendMu.Lock()
	defer r.sendMu.Unlock()
	for len(msg) > 0 {
		n := min(len(msg), rtcChunk-1)
		part := make([]byte, 1+n)
		if n == len(msg) {
			part[0] = 1
		}
		copy(part[1:], msg[:n])
		if dc.Send(part) != nil {
			return false
		}
		msg = msg[n:]
	}
	return true
}

func (r *rtcPeer) close() {
	if r.closed.Swap(true) {
		return
	}
	r.dc.Store(nil)
	_ = r.pc.Close()
}

// handleRTC — sygnalizacja od przeglądarki (oferta, kandydaci) dla tego oglądającego.
func (v *desktopViewer) handleRTC(p []byte) {
	var sig rtcSignal
	if json.Unmarshal(p, &sig) != nil {
		return
	}
	switch {
	case sig.SDP != nil && sig.SDP.Type == webrtc.SDPTypeOffer:
		v.startRTC(*sig.SDP)
	case sig.Cand != nil:
		v.rtcMu.Lock()
		r := v.rtc
		if r != nil && r.pc.RemoteDescription() == nil {
			r.pending = append(r.pending, *sig.Cand)
			r = nil
		}
		v.rtcMu.Unlock()
		if r != nil {
			_ = r.pc.AddICECandidate(*sig.Cand)
		}
	}
}

func (v *desktopViewer) startRTC(offer webrtc.SessionDescription) {
	v.stopRTC() // nowa oferta (np. ponowna próba) zastępuje poprzednie połączenie
	var servers []webrtc.ICEServer
	for _, s := range v.ice {
		servers = append(servers, webrtc.ICEServer{URLs: s.URLs, Username: s.Username, Credential: s.Credential})
	}
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		logger.Warningf("pulpit %d: WebRTC: %v", v.ch, err)
		return
	}
	r := &rtcPeer{pc: pc}
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		v.signal(rtcSignal{T: "cand", Cand: &init})
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "desk" {
			return
		}
		dc.OnOpen(func() {
			if r.closed.Load() {
				return
			}
			r.dc.Store(dc)
			logger.Infof("pulpit %d: połączenie bezpośrednie (WebRTC)", v.ch)
			_ = v.g.toHelper(msgEvent, []byte(`{"t":"kf"}`)) // pełna klatka już nową drogą
		})
		dc.OnClose(func() {
			if r.dc.CompareAndSwap(dc, nil) {
				logger.Infof("pulpit %d: koniec połączenia bezpośredniego — dalej przez serwer", v.ch)
				_ = v.g.toHelper(msgEvent, []byte(`{"t":"kf"}`))
			}
		})
		dc.OnMessage(func(m webrtc.DataChannelMessage) { v.rtcInput(m.Data) })
	})
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		if s == webrtc.PeerConnectionStateFailed || s == webrtc.PeerConnectionStateClosed {
			if r.dc.Swap(nil) != nil {
				_ = v.g.toHelper(msgEvent, []byte(`{"t":"kf"}`))
			}
		}
	})

	v.rtcMu.Lock()
	v.rtc = r
	v.rtcMu.Unlock()
	if err := pc.SetRemoteDescription(offer); err != nil {
		logger.Warningf("pulpit %d: WebRTC (oferta): %v", v.ch, err)
		v.stopRTC()
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err == nil {
		err = pc.SetLocalDescription(answer)
	}
	if err != nil {
		logger.Warningf("pulpit %d: WebRTC (odpowiedź): %v", v.ch, err)
		v.stopRTC()
		return
	}
	v.signal(rtcSignal{T: "answer", SDP: pc.LocalDescription()})
	v.rtcMu.Lock()
	pending := r.pending
	r.pending = nil
	v.rtcMu.Unlock()
	for _, c := range pending {
		_ = pc.AddICECandidate(c)
	}
}

func (v *desktopViewer) stopRTC() {
	v.rtcMu.Lock()
	r := v.rtc
	v.rtc = nil
	v.rtcMu.Unlock()
	if r != nil {
		r.close()
	}
}

// signal — wiadomość sygnalizacji do przeglądarki (zawsze przez serwer).
func (v *desktopViewer) signal(s rtcSignal) {
	b, _ := json.Marshal(s)
	_ = v.sess.writeBinary(encodeFrame(frameData, v.ch, append([]byte{msgRTC}, b...)))
}

// deliver — wiadomość do przeglądarki: kanałem bezpośrednim, a gdy go nie ma — przez serwer.
func (v *desktopViewer) deliver(msg []byte) {
	v.rtcMu.Lock()
	r := v.rtc
	v.rtcMu.Unlock()
	if r != nil && r.send(msg) {
		return
	}
	_ = v.sess.writeBinary(encodeFrame(frameData, v.ch, msg))
}

var keyCodeRe = regexp.MustCompile(`^[A-Za-z0-9]{1,24}$`)

// rtcInput — zdarzenie z kanału bezpośredniego. Serwer go nie widzi, więc sprawdzamy je tutaj
// tak samo jak serwer: tylko ruch, przyciski, kółko, klawisze i potwierdzenia, z poprawnymi wartościami.
func (v *desktopViewer) rtcInput(p []byte) {
	if len(p) > 1024 {
		return
	}
	var ev InputEvent
	if json.Unmarshal(p, &ev) != nil {
		return
	}
	switch ev.T {
	case "ack":
		v.ack(1)
		return
	case "m", "b":
		if !inUnit(ev.X) || !inUnit(ev.Y) || (ev.T == "b" && (ev.B < 0 || ev.B > 2)) {
			return
		}
	case "w":
		if ev.DY < -2400 || ev.DY > 2400 {
			return
		}
	case "k":
		if !keyCodeRe.MatchString(ev.Code) {
			return
		}
	default:
		return // reszta tylko przez serwer
	}
	if v.viewOnly {
		return
	}
	clean := InputEvent{T: ev.T, X: ev.X, Y: ev.Y, B: ev.B, D: ev.D, DY: ev.DY, Code: ev.Code}
	b, _ := json.Marshal(clean)
	_ = v.write(b)
}

func inUnit(f float64) bool { return !math.IsNaN(f) && f >= 0 && f <= 1 }
