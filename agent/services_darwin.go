//go:build darwin

package main

import (
	"context"
	"os/exec"
	"strings"
)

// Usługi macOS = demony launchd w domenie system (agent działa jako root).
func listServices(ctx context.Context) ([]ServiceInfo, error) {
	out, err := exec.CommandContext(ctx, "launchctl", "list").Output()
	if err != nil {
		return nil, err
	}
	return parseLaunchctl(out), nil
}

func controlService(ctx context.Context, name, action string) error {
	target := "system/" + name
	var args []string
	switch action {
	case "start":
		args = []string{"kickstart", target}
	case "restart":
		args = []string{"kickstart", "-k", target}
	case "stop":
		args = []string{"kill", "SIGTERM", target}
	case "enable":
		args = []string{"enable", target}
	case "disable":
		args = []string{"disable", target}
	}
	out, err := exec.CommandContext(ctx, "launchctl", args...).CombinedOutput()
	if err != nil {
		return protoErr("svc_failed", "launchctl %s: %s", strings.Join(args, " "), strings.TrimSpace(string(out)))
	}
	return nil
}
