package main

// Zdarzenia agenta do dziennika serwera (np. klient kiosku zakończył sesję). Wysyłane przez bieżące
// połączenie; bez połączenia — przepadają (dziennik to informacja, nie warunek działania).

type agentEvent struct {
	Action  string         `json:"action"`
	Details map[string]any `json:"details,omitempty"`
}

var agentEvents = make(chan agentEvent, 16)

func reportAgentEvent(action string, details map[string]any) {
	select {
	case agentEvents <- agentEvent{Action: action, Details: details}:
	default:
	}
}
