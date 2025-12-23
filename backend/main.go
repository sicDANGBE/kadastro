package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/sicDANGBE/kadastro/handlers"
)

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/api/cadastre", handlers.GetParcelles)
	mux.HandleFunc("/api/dvf", handlers.GetDVF)

	// Middleware CORS pour le dev local
	wrappedMux := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusOK)
			return
		}
		mux.ServeHTTP(w, r)
	})

	fmt.Println("🚀 Serveur Kadastro prêt sur http://localhost:8080")
	if err := http.ListenAndServe(":8080", wrappedMux); err != nil {
		log.Fatal(err)
	}
}
