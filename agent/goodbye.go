package main

import "sync"

// „Do widzenia” dla serwera przy planowanym końcu pracy agenta: wyłączenie / restart systemu, zatrzymanie
// usługi, aktualizacja. Bez tego serwer nie odróżni wyłączonego komputera od zerwanego połączenia
// (awaria sieci, zawieszenie, odcięcie prądu) i zgłasza alert „komputer offline”.

var goodbye struct {
	mu   sync.Mutex
	fn   func(reason string)
	done bool
}

func setGoodbye(fn func(string)) {
	goodbye.mu.Lock()
	goodbye.fn = fn
	goodbye.mu.Unlock()
}

// sayGoodbye — wysyła powód raz (Shutdown woła potem Stop — liczy się pierwszy powód).
func sayGoodbye(reason string) {
	goodbye.mu.Lock()
	defer goodbye.mu.Unlock()
	if goodbye.done || goodbye.fn == nil {
		return
	}
	goodbye.done = true
	goodbye.fn(reason)
}
