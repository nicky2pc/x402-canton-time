// GET /time costs 0.01 CC, GET /health is free. Payments settle through FTP's facilitator.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/FTP-Tech-LLC/x402-canton-merchant/go/canton"
)

func main() {
	payTo := os.Getenv("CANTON_X402_PAYTO")
	if payTo == "" {
		log.Fatal("set CANTON_X402_PAYTO to the party you are paid to")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := canton.Config{
		FacilitatorURL: os.Getenv("FACILITATOR_URL"), // empty: https://facilitator.ftptech.xyz
		Routes: map[string]canton.Route{
			"GET /time": {PayTo: payTo, Price: canton.CC("0.01"), Description: "Current time"},
		},
	}
	paid, err := canton.NewGate(ctx, cfg)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /time", func(w http.ResponseWriter, _ *http.Request) {
		now := time.Now().UTC()
		writeJSON(w, struct {
			Unix int64  `json:"unix"`
			ISO  string `json:"iso"`
		}{now.Unix(), now.Format("2006-01-02T15:04:05.000Z")})
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "3402"
	}
	server := &http.Server{Addr: ":" + port, Handler: paid.Middleware()(mux), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("x402-canton-time (Go) on :%s", port)
		if err := server.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	<-ctx.Done()

	// Paid requests may be mid-settle: give them the full budget, then close the gate.
	budget := canton.RequestBudget(cfg)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), budget)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
	closeCtx, closeCancel := context.WithTimeout(context.Background(), budget)
	defer closeCancel()
	_ = paid.Close(closeCtx)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
