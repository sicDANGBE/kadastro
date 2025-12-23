package handlers

import (
	"fmt"
	"io"
	"net/http"
)

// GetDVF récupère les ventes d'une seule parcelle
func GetDVF(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id_parcelle")
	url := fmt.Sprintf("https://dvf-api.data.gouv.fr/dvf/mutation/?code_parcelle=%s", id)
	proxyRequest(url, w)
}

// GetDVFByCommune récupère toutes les ventes d'une commune (Heatmap)
func GetDVFByCommune(w http.ResponseWriter, r *http.Request) {
	codeInsee := r.URL.Query().Get("code_insee")
	url := fmt.Sprintf("https://dvf-api.data.gouv.fr/dvf/mutation/?code_commune=%s", codeInsee)
	proxyRequest(url, w)
}

func proxyRequest(url string, w http.ResponseWriter) {
	resp, err := http.Get(url)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()
	w.Header().Set("Content-Type", "application/json")
	io.Copy(w, resp.Body)
}
