# Export de projet

_Généré le 2025-12-23T22:20:08+01:00_

## .github/workflows/pull_request.yml

```yaml
name: CI - Quality Check

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]

jobs:
  test-and-build-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Tests Frontend
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install & Type Check Frontend
        run: |
          cd frontend
          corepack enable
          pnpm install
          pnpm build # Vérifie que le front compile sans erreur TS

      # 2. Tests Backend
      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23' # Ou ta version
      - name: Test Backend
        run: |
          cd backend
          go test ./... 

      # 3. Dry Run Docker (On build mais on ne push pas)
      - name: Verify Docker Build
        run: docker build .
```

## .github/workflows/release.yml

```yaml
name: Build & Release (Tag Only)

on:
  push:
    tags:
      - 'v*' # Se déclenche UNIQUEMENT si le push est un tag (ex: v1.0.1)

env:
  IMAGE_NAME: spadmdck/klaro

jobs:
  build-release-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Pour créer la Release GitHub
    
    steps:
      - uses: actions/checkout@v4

      # 1. Récupération de la version depuis package.json
      # C'est la source de vérité.
      - name: Extract version
        id: version
        run: |
          VERSION=$(jq -r .version package.json)
          # Vérification de sécurité : Le tag Git DOIT matcher le package.json
          # Si tu as tagué v1.0.1 mais que le json dit 1.0.0, ça coupe.
          if [[ "v$VERSION" != "${{ github.ref_name }}" ]]; then
            echo "❌ Erreur : Le tag Git (${{ github.ref_name }}) ne correspond pas au package.json ($VERSION)"
            exit 1
          fi
          echo "VERSION=$VERSION" >> $GITHUB_OUTPUT

      # 2. Docker Build & Push (Hub Propre)
      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build and Push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          # On ne crée que 2 tags : la version précise et le latest
          tags: |
            ${{ env.IMAGE_NAME }}:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_NAME }}:latest

      # 3. Création de la Release GitHub
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          name: Klaro v${{ steps.version.outputs.VERSION }}
          generate_release_notes: true
          prerelease: false

  # JOB DEPLOIEMENT (Sur ton Cluster)
  deploy-to-cluster:
    needs: build-release-deploy
    runs-on: [self-hosted, k8s-deploy]
    if: success()
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Get Version
        id: get_version
        run: echo "VERSION=$(jq -r .version package.json)" >> $GITHUB_OUTPUT

      - name: Deploy to K3s
        env:
          TAG: ${{ steps.get_version.outputs.VERSION }}
        run: |
          echo "🚀 Déploiement de la version $TAG..."
          
          # Mise à jour de l'image dans le déploiement K8s
          kubectl set image deployment/klaro klaro=${{ env.IMAGE_NAME }}:$TAG -n apps
          
          # Vérification
          kubectl rollout status deployment/klaro -n apps
          echo "✅ Production mise à jour en v$TAG"
```

## .gitignore

```text
# Binaires et Builds
dist/
bin/
main
backend/main
backend/tmp/

# Dépendances
node_modules/
.pnpm-store/

# IDE & OS
.vscode/
.idea/
.DS_Store

# Base de données (IMPORTANT : ne jamais commit la DB de prod/dev)
*.db
*.db-journal
*.sqlite

# Environnement
.env

# sanitaize
san_*


```

## Dockerfile

```text
# ==============================================================================
# STAGE 1: Builder Frontend (Node.js)
# Objectif : Compiler le JS/CSS et générer le dossier /dist
# ==============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Installation de pnpm via corepack (plus propre que npm i -g)
RUN corepack enable && corepack prepare pnpm@latest --activate

# On copie uniquement les fichiers de dépendances pour profiter du cache Docker
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Installation des dépendances
RUN pnpm install --frozen-lockfile --filter frontend

# Copie du code source et build
COPY frontend ./frontend
RUN pnpm --filter frontend build

# ==============================================================================
# STAGE 2: Builder Backend (Go)
# Objectif : Compiler un binaire statique autonome
# ==============================================================================
FROM golang:1.25-alpine AS backend-builder

WORKDIR /src

# Installation des certificats CA (nécessaire si l'app fait des requêtes HTTPS sortantes)
# et tzdata pour la gestion des timezones
RUN apk update && apk add --no-cache git ca-certificates tzdata && update-ca-certificates

# Gestion des dépendances (Cache warming)
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copie du code source Go
COPY backend/ .

# Compilation optimisée :
# - CGO_ENABLED=0 : Pour créer un binaire statique pur (sans lien vers libc)
# - -ldflags="-w -s" : Retire les infos de debug (dwarf) pour réduire la taille (~20-30%)
# - -o /app/server : Sortie du binaire
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /app/server ./cmd/server
# Création d'un utilisateur non-root pour la sécurité (uid 10001)
# On ne veut JAMAIS tourner en root dans le conteneur final
RUN echo "appuser:x:10001:10001:App User:/:" > /etc_passwd

# ==============================================================================
# STAGE 3: Final Image (Scratch)
# Objectif : L'image la plus petite et sécurisée possible (pas de shell, pas d'OS)
# ==============================================================================
FROM scratch

# Import des fichiers essentiels depuis les builders
COPY --from=backend-builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=backend-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend-builder /etc_passwd /etc/passwd

# Copie du binaire Go
COPY --from=backend-builder /app/server /server

# Copie des assets statiques (Frontend compilé)
# Le serveur Go devra être configuré pour servir ce dossier
COPY --from=frontend-builder /app/frontend/dist /static

# On bascule sur l'utilisateur non-privilégié
USER appuser

# Exposition du port
EXPOSE 8080

# Démarrage
ENTRYPOINT ["/server"]
```

## Makefile

```text
# ==============================================================================
# KLARO - Project Makefile
# Orchestration: User (DevOps Context)
# Implementation: Gemini
# ==============================================================================

PROJECT_NAME := klaro
BACKEND_DIR  := backend
FRONTEND_DIR := frontend
DOCKER_REG   := registry.votre-domaine.fr# À adapter pour ton infra OVH
IMAGE_NAME   := $(DOCKER_REG)/$(PROJECT_NAME)
VERSION      := $(shell git rev-parse --short HEAD 2>/dev/null || echo "latest")

# Détection de l'environnement
GO   := go
PNPM := pnpm
AIR  := $(shell go env GOPATH)/bin/air

.PHONY: all init dev build clean docker-build deploy help

help:
	@echo "🛠️  Usage: make [target]"
	@echo ""
	@echo "Développement:"
	@echo "  init        Initialise la structure (Go, Vue-TS, Tailwind)"
	@echo "  dev         Lance Backend (Air) et Frontend (Vite) en parallèle"
	@echo "  tidy        Nettoie et met à jour les dépendances Go"
	@echo ""
	@echo "Build & CI:"
	@echo "  build       Compile le binaire Go et build le Frontend"
	@echo "  docker      Construit l'image Docker multi-stage"
	@echo "  push        Push l'image sur ton registry"
	@echo ""
	@echo "Déploiement (k3s):"
	@echo "  deploy      Applique les manifestes k8s sur ton cluster"

# ==============================================================================
# 1. INITIALISATION
# ==============================================================================
init:
	@echo "🚀 Initialisation de $(PROJECT_NAME)..."
	mkdir -p $(BACKEND_DIR)
	
	# Setup Backend
	@echo "⚙️  Setup Backend (Go)..."
	@if [ ! -f "$(BACKEND_DIR)/go.mod" ]; then \
		cd $(BACKEND_DIR) && $(GO) mod init github.com/votre-user/$(PROJECT_NAME); \
	fi
	cd $(BACKEND_DIR) && $(GO) get -u github.com/go-chi/chi/v5 github.com/go-chi/cors
	@if ! command -v air > /dev/null; then \
		echo "📦 Installation de Air..."; \
		$(GO) install github.com/air-verse/air@latest; \
	fi

	# Setup Frontend
	@echo "🎨 Setup Frontend (Vue.js + TS)..."
	@if [ ! -d "$(FRONTEND_DIR)/src" ]; then \
		$(PNPM) create vite $(FRONTEND_DIR) --template vue-ts; \
	fi
	
	@echo "🔗 Configuration Workspace & Tailwind..."
	@echo "packages:\n  - '$(FRONTEND_DIR)'" > pnpm-workspace.yaml
	cd $(FRONTEND_DIR) && $(PNPM) install
	cd $(FRONTEND_DIR) && $(PNPM) add -D tailwindcss postcss autoprefixer

	@echo "✅ Initialisation terminée !"

# ==============================================================================
# 2. DÉVELOPPEMENT
# ==============================================================================
dev:
	@echo "🔥 Lancement de l'environnement hybride..."
	$(MAKE) -j2 dev-back dev-front

dev-back:
	@echo "🐘 Backend via Air..."
	cd $(BACKEND_DIR) && $(AIR)

dev-front:
	@echo "✨ Frontend via Vite..."
	cd $(FRONTEND_DIR) && $(PNPM) dev

tidy:
	cd $(BACKEND_DIR) && $(GO) mod tidy

# ==============================================================================
# 3. BUILD & DOCKER
# ==============================================================================
build: build-front build-back

build-front:
	@echo "📦 Build Frontend..."
	cd $(FRONTEND_DIR) && $(PNPM) build

build-back:
	@echo "🔨 Build Backend (Linux binary)..."
	cd $(BACKEND_DIR) && CGO_ENABLED=0 GOOS=linux $(GO) build -o ../bin/$(PROJECT_NAME) main.go

docker:
	@echo "🐳 Construction de l'image Docker [$(VERSION)]..."
	docker build -t $(IMAGE_NAME):$(VERSION) -t $(IMAGE_NAME):latest .

push:
	@echo "📤 Push vers le registry..."
	docker push $(IMAGE_NAME):$(VERSION)
	docker push $(IMAGE_NAME):latest

# ==============================================================================
# 4. K3S DEPLOYMENT
# ==============================================================================
deploy:
	@echo "☸️  Déploiement sur k3s..."
	# On suppose que tes manifests sont dans /k8s
	kubectl apply -f k8s/

clean:
	rm -rf bin/
	rm -rf $(FRONTEND_DIR)/dist
	@echo "✨ Nettoyage effectué."
```

## backend/.air.toml

```toml
# backend/.air.toml

root = "."
tmp_dir = "tmp"

[build]
  # C'est ICI la clé : on lui dit de builder le dossier cmd/server
  cmd = "go build -o ./tmp/main ./cmd/server"
  
  # Où se trouve le binaire généré
  bin = "./tmp/main"

  # Pour éviter de relancer le build si on touche aux tests ou aux assets
  exclude_dir = ["assets", "tmp", "vendor", "testdata"]
  include_ext = ["go", "tpl", "tmpl", "html"]
  
  # Délai avant rebuild (évite les glitchs si tu saves vite)
  delay = 1000

[log]
  time = true

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"
```

## backend/Dockerfile

```text
# ==============================================================================
# STAGE 1: Builder Frontend (Node.js)
# Objectif : Compiler le JS/CSS et générer le dossier /dist
# ==============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Installation de pnpm via corepack (plus propre que npm i -g)
RUN corepack enable && corepack prepare pnpm@latest --activate

# On copie uniquement les fichiers de dépendances pour profiter du cache Docker
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Installation des dépendances
RUN pnpm install --frozen-lockfile --filter frontend

# Copie du code source et build
COPY frontend ./frontend
RUN pnpm --filter frontend build

# ==============================================================================
# STAGE 2: Builder Backend (Go)
# Objectif : Compiler un binaire statique autonome
# ==============================================================================
FROM golang:1.25-alpine AS backend-builder

WORKDIR /src

# Installation des certificats CA (nécessaire si l'app fait des requêtes HTTPS sortantes)
# et tzdata pour la gestion des timezones
RUN apk update && apk add --no-cache git ca-certificates tzdata && update-ca-certificates

# Gestion des dépendances (Cache warming)
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copie du code source Go
COPY backend/ .

# Compilation optimisée :
# - CGO_ENABLED=0 : Pour créer un binaire statique pur (sans lien vers libc)
# - -ldflags="-w -s" : Retire les infos de debug (dwarf) pour réduire la taille (~20-30%)
# - -o /app/server : Sortie du binaire
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /app/server ./cmd/server
# Création d'un utilisateur non-root pour la sécurité (uid 10001)
# On ne veut JAMAIS tourner en root dans le conteneur final
RUN echo "appuser:x:10001:10001:App User:/:" > /etc_passwd

# ==============================================================================
# STAGE 3: Final Image (Scratch)
# Objectif : L'image la plus petite et sécurisée possible (pas de shell, pas d'OS)
# ==============================================================================
FROM scratch

# Import des fichiers essentiels depuis les builders
COPY --from=backend-builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=backend-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend-builder /etc_passwd /etc/passwd

# Copie du binaire Go
COPY --from=backend-builder /app/server /server

# Copie des assets statiques (Frontend compilé)
# Le serveur Go devra être configuré pour servir ce dossier
COPY --from=frontend-builder /app/frontend/dist /static

# On bascule sur l'utilisateur non-privilégié
USER appuser

# Exposition du port
EXPOSE 8080

# Démarrage
ENTRYPOINT ["/server"]
```

## backend/Makefile

```text
# ==============================================================================
# KLARO - Project Makefile
# Orchestration: User
# Implementation: Gemini
# ==============================================================================

# Variables de projet
PROJECT_NAME := klaro
BACKEND_DIR := backend
FRONTEND_DIR := frontend

# Détection de l'OS pour les commandes spécifiques (optionnel mais propre)
GO := go
PNPM := pnpm

.PHONY: all init dev build clean docker-build help

# Par défaut, on affiche l'aide
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  init        Initialise la structure (Go module, Vue app, Pnpm workspace)"
	@echo "  dev         Lance le serveur Go (avec Air) et Vite en parallèle"
	@echo "  build       Compile le binaire Go et build le Frontend"
	@echo "  docker      Construit l'image Docker optimisée"
	@echo "  clean       Nettoie les artefacts de build"

# ==============================================================================
# 1. INITIALISATION
# ==============================================================================
init:
	@echo "🚀 Initialisation de Klaro..."
	
	# 1. Création des dossiers
	mkdir -p $(BACKEND_DIR)
	
	# 2. Setup Backend (Go)
	@echo "⚙️  Setup Backend (Go)..."
	# On ignore l'erreur si le mod existe déjà (|| true)
	cd $(BACKEND_DIR) && $(GO) mod init github.com/sicDANGBE/$(PROJECT_NAME) || true
	cd $(BACKEND_DIR) && $(GO) get -u github.com/go-chi/chi/v5 gorm.io/gorm gorm.io/driver/sqlite
	@if ! command -v air > /dev/null; then \
		echo "📦 Installation de Air (Live Reload)..."; \
		$(GO) install github.com/air-verse/air@latest; \
	fi

	# 3. Setup Frontend (Vue + Vite + Tailwind)
	@echo "🎨 Setup Frontend (Vue.js)..."
	# Si le dossier existe déjà, create vite va échouer, on check avant
	@if [ ! -d "$(FRONTEND_DIR)/src" ]; then \
		$(PNPM) create vite $(FRONTEND_DIR) --template vue-ts; \
	fi
	
	# 4. Setup Workspace & Deps
	@echo "🔗 Setup Workspace..."
	echo "packages:\n  - 'frontend'" > pnpm-workspace.yaml
	
	# Installation propre avec pnpm
	cd $(FRONTEND_DIR) && $(PNPM) install
	cd $(FRONTEND_DIR) && $(PNPM) install -D tailwindcss postcss autoprefixer
	
	# CORRECTION ICI: On utilise pnpm pour executer le binaire local
	cd $(FRONTEND_DIR) && $(PNPM) dlx tailwindcss init -p

	@echo "✅ Initialisation terminée ! Lance 'make dev' pour démarrer."

# ==============================================================================
# 2. DEVELOPPEMENT
# ==============================================================================
dev:
	@echo "🔥 Lancement de l'environnement de dev..."
	# On utilise make -j2 pour lancer les deux processus en parallèle
	# Le backend écoute sur le port 8080, le front sur 5173
	make -j2 dev-back dev-front

dev-back:
	@echo "🐘 Backend (Go + Air)..."
	cd $(BACKEND_DIR) && $$(go env GOPATH)/bin/air

dev-front:
	@echo "✨ Frontend (Vite)..."
	cd $(FRONTEND_DIR) && $(PNPM) dev

# ==============================================================================
# 3. BUILD & DOCKER
# ==============================================================================
docker:
	@echo "🐳 Construction de l'image Docker sécurisée..."
	docker build -t $(PROJECT_NAME):latest .
```

## backend/api/handlers.go

```go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/store"
	"gorm.io/gorm"
)

// Handler détient la connexion DB pour l'injecter dans les requêtes
type Handler struct {
	DB *gorm.DB
}

// NewHandler est le constructeur de notre couche API
func NewHandler(db *gorm.DB) *Handler {
	return &Handler{DB: db}
}

// =============================================================================
// HANDLERS HTTP (CRUD)
// =============================================================================

// GetItems récupère les tâches.
// Paramètres query optionnels : ?start=2025-01-01&end=2025-01-31 (Pour le calendrier)
// Si pas de dates : renvoie tout (ou filtrer pour le backlog plus tard)
func (h *Handler) GetItems(w http.ResponseWriter, r *http.Request) {
	var items []store.Item

	// Initialisation de la requête
	query := h.DB.Preload("SubTasks").Order("date ASC") // Preload charge les sous-tâches

	// Filtrage par date si demandé (Vue Calendrier)
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")

	if start != "" && end != "" {
		// On cherche les items dont la date est comprise dans l'intervalle
		query = query.Where("date BETWEEN ? AND ?", start, end)
	}

	// TODO: Pour le backlog (droite), on voudra peut-être : query.Where("date IS NULL")

	if result := query.Find(&items); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, items)
}

// CreateItem crée une nouvelle entrée (Event, Envie, etc.)
func (h *Handler) CreateItem(w http.ResponseWriter, r *http.Request) {
	var item store.Item

	// Décodage du JSON entrant
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Sauvegarde en DB
	if result := h.DB.Create(&item); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, item)
}

// ToggleSubTask change l'état d'une sous-tâche (Check/Uncheck)
func (h *Handler) ToggleSubTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Requête SQL optimisée : On inverse juste le booléen
	// UPDATE sub_tasks SET is_done = NOT is_done WHERE id = ?
	if err := h.DB.Model(&store.SubTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

// DeleteItem supprime un item (Soft Delete par défaut avec GORM)
func (h *Handler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Conversion string -> uint
	uID, _ := strconv.ParseUint(id, 10, 32)

	// Delete
	h.DB.Delete(&store.Item{}, uID)

	w.WriteHeader(http.StatusNoContent)
}

// UpdateItem met à jour un item (ex: Drag & Drop calendrier)
func (h *Handler) UpdateItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// 1. Check existence
	var item store.Item
	if err := h.DB.First(&item, id).Error; err != nil {
		http.Error(w, "Item not found", http.StatusNotFound)
		return
	}

	// 2. Decode payload
	var payload store.Item
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 3. Update (Gorm Updates ignore les champs zero-value, parfait pour le PATCH partiel)
	// Attention: Si on veut remettre une date à NULL (retour inbox), il faudra une logique spécifique.
	// Pour l'instant on gère le mouvement vers le calendrier.
	if err := h.DB.Model(&item).Updates(payload).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, item)
}

// =============================================================================
// UTILITAIRES
// =============================================================================

// respondJSON formate la réponse en JSON standard
func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

```

## backend/cmd/server/main.go

```go
package main

import (
	"fmt"
	"net/http"
	"time"
)

// Proxy pour récupérer les parcelles d'une commune
func getParcellesHandler(w http.ResponseWriter, r *http.Request) {
	codeInsee := r.URL.Query().Get("code_insee")
	if codeInsee == "" {
		http.Error(w, "Code INSEE manquant", http.StatusBadRequest)
		return
	}

	// Appel à l'API DataGouv
	url := fmt.Sprintf("https://cadastre.data.gouv.fr/bundler/cadastre-etalab/communes/%s/geojson/parcelles", codeInsee)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		http.Error(w, "Erreur lors de l'appel API Cadastre", http.StatusInternalServerError)
		return
	}
	defer resp.Body.Close()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*") // Pour le dev

	// On pipe directement la réponse pour plus de performance
	if _, err := fmt.Fprint(w, resp.Body); err != nil {
		return
	}
}

func main() {
	http.HandleFunc("/api/cadastre", getParcellesHandler)
	fmt.Println("Backend démarré sur :8080")
	http.ListenAndServe(":8080", nil)
}

```

## backend/go.mod

```text
module github.com/sicDANGBE/kadastro

go 1.25.1

require (
	github.com/glebarez/sqlite v1.11.0
	github.com/go-chi/chi/v5 v5.2.3
	github.com/go-chi/cors v1.2.2
	gorm.io/gorm v1.31.1
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/glebarez/go-sqlite v1.21.2 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	github.com/mattn/go-isatty v0.0.17 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.7.0 // indirect
	golang.org/x/text v0.32.0 // indirect
	modernc.org/libc v1.22.5 // indirect
	modernc.org/mathutil v1.5.0 // indirect
	modernc.org/memory v1.5.0 // indirect
	modernc.org/sqlite v1.23.1 // indirect
)

```

## backend/go.sum

```text
github.com/dustin/go-humanize v1.0.1 h1:GzkhY7T5VNhEkwH0PVJgjz+fX1rhBrR7pRT3mDkpeCY=
github.com/dustin/go-humanize v1.0.1/go.mod h1:Mu1zIs6XwVuF/gI1OepvI0qD18qycQx+mFykh5fBlto=
github.com/glebarez/go-sqlite v1.21.2 h1:3a6LFC4sKahUunAmynQKLZceZCOzUthkRkEAl9gAXWo=
github.com/glebarez/go-sqlite v1.21.2/go.mod h1:sfxdZyhQjTM2Wry3gVYWaW072Ri1WMdWJi0k6+3382k=
github.com/glebarez/sqlite v1.11.0 h1:wSG0irqzP6VurnMEpFGer5Li19RpIRi2qvQz++w0GMw=
github.com/glebarez/sqlite v1.11.0/go.mod h1:h8/o8j5wiAsqSPoWELDUdJXhjAhsVliSn7bWZjOhrgQ=
github.com/go-chi/chi/v5 v5.2.3 h1:WQIt9uxdsAbgIYgid+BpYc+liqQZGMHRaUwp0JUcvdE=
github.com/go-chi/chi/v5 v5.2.3/go.mod h1:L2yAIGWB3H+phAw1NxKwWM+7eUH/lU8pOMm5hHcoops=
github.com/go-chi/cors v1.2.2 h1:Jmey33TE+b+rB7fT8MUy1u0I4L+NARQlK6LhzKPSyQE=
github.com/go-chi/cors v1.2.2/go.mod h1:sSbTewc+6wYHBBCW7ytsFSn836hqM7JxpglAy2Vzc58=
github.com/google/pprof v0.0.0-20221118152302-e6195bd50e26 h1:Xim43kblpZXfIBQsbuBVKCudVG457BR2GZFIz3uw3hQ=
github.com/google/pprof v0.0.0-20221118152302-e6195bd50e26/go.mod h1:dDKJzRmX4S37WGHujM7tX//fmj1uioxKzKxz3lo4HJo=
github.com/google/uuid v1.3.0 h1:t6JiXgmwXMjEs8VusXIJk2BXHsn+wx8BZdTaoZ5fu7I=
github.com/google/uuid v1.3.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=
github.com/jinzhu/inflection v1.0.0 h1:K317FqzuhWc8YvSVlFMCCUb36O/S9MCKRDI7QkRKD/E=
github.com/jinzhu/inflection v1.0.0/go.mod h1:h+uFLlag+Qp1Va5pdKtLDYj+kHp5pxUVkryuEj+Srlc=
github.com/jinzhu/now v1.1.5 h1:/o9tlHleP7gOFmsnYNz3RGnqzefHA47wQpKrrdTIwXQ=
github.com/jinzhu/now v1.1.5/go.mod h1:d3SSVoowX0Lcu0IBviAWJpolVfI5UJVZZ7cO71lE/z8=
github.com/mattn/go-isatty v0.0.17 h1:BTarxUcIeDqL27Mc+vyvdWYSL28zpIhv3RoTdsLMPng=
github.com/mattn/go-isatty v0.0.17/go.mod h1:kYGgaQfpe5nmfYZH+SKPsOc2e4SrIfOl2e/yFXSvRLM=
github.com/remyoudompheng/bigfft v0.0.0-20200410134404-eec4a21b6bb0/go.mod h1:qqbHyh8v60DhA7CoWK5oRCqLrMHRGoxYCSS9EjAz6Eo=
github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec h1:W09IVJc94icq4NjY3clb7Lk8O1qJ8BdBEF8z0ibU0rE=
github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec/go.mod h1:qqbHyh8v60DhA7CoWK5oRCqLrMHRGoxYCSS9EjAz6Eo=
golang.org/x/sys v0.0.0-20220811171246-fbc7d0a398ab/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
golang.org/x/sys v0.7.0 h1:3jlCCIQZPdOYu1h8BkNvLz8Kgwtae2cagcG/VamtZRU=
golang.org/x/sys v0.7.0/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
golang.org/x/text v0.32.0 h1:ZD01bjUt1FQ9WJ0ClOL5vxgxOI/sVCNgX1YtKwcY0mU=
golang.org/x/text v0.32.0/go.mod h1:o/rUWzghvpD5TXrTIBuJU77MTaN0ljMWE47kxGJQ7jY=
gorm.io/gorm v1.31.1 h1:7CA8FTFz/gRfgqgpeKIBcervUn3xSyPUmr6B2WXJ7kg=
gorm.io/gorm v1.31.1/go.mod h1:XyQVbO2k6YkOis7C2437jSit3SsDK72s7n7rsSHd+Gs=
modernc.org/libc v1.22.5 h1:91BNch/e5B0uPbJFgqbxXuOnxBQjlS//icfQEGmvyjE=
modernc.org/libc v1.22.5/go.mod h1:jj+Z7dTNX8fBScMVNRAYZ/jF91K8fdT2hYMThc3YjBY=
modernc.org/mathutil v1.5.0 h1:rV0Ko/6SfM+8G+yKiyI830l3Wuz1zRutdslNoQ0kfiQ=
modernc.org/mathutil v1.5.0/go.mod h1:mZW8CKdRPY1v87qxC/wUdX5O1qDzXMP5TH3wjfpga6E=
modernc.org/memory v1.5.0 h1:N+/8c5rE6EqugZwHii4IFsaJ7MUhoWX07J5tC/iI5Ds=
modernc.org/memory v1.5.0/go.mod h1:PkUhL0Mugw21sHPeskwZW4D6VscE/GQJOnIpCnW6pSU=
modernc.org/sqlite v1.23.1 h1:nrSBg4aRQQwq59JpvGEQ15tNxoO5pX/kUjcRNwSAGQM=
modernc.org/sqlite v1.23.1/go.mod h1:OrDj17Mggn6MhE+iPbBNf7RGKODDE9NFT0f3EwDzJqk=

```

## backend/internal/database/db.go

```go
package database

import (
	"log"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Init(dbPath string) *gorm.DB {
	// Création du dossier si inexistant
	dir := filepath.Dir(dbPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		_ = os.MkdirAll(dir, 0755)
	}

	// Connexion
	db, err := gorm.Open(sqlite.Open(dbPath+"?_pragma=busy_timeout(5000)"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatal("❌ DB Connection failed:", err)
	}

	// Migration de TOUS les modèles
	err = db.AutoMigrate(
		&models.Item{},
		&models.SubTask{},
		&models.Epic{},
		&models.EpicTask{},
	)
	if err != nil {
		log.Fatal("❌ DB Migration failed:", err)
	}

	log.Println("✅ Database initialized & migrated.")
	return db
}

```

## backend/internal/handlers/epic_handler.go

```go
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
)

type EpicHandler struct {
	DB *gorm.DB
}

func NewEpicHandler(db *gorm.DB) *EpicHandler {
	return &EpicHandler{DB: db}
}

// GET /api/epics
func (h *EpicHandler) GetEpics(w http.ResponseWriter, r *http.Request) {
	var epics []models.Epic
	// On trie par date de début
	if result := h.DB.Preload("Tasks").Order("start_date ASC").Find(&epics); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, epics)
}

// POST /api/epics
func (h *EpicHandler) CreateEpic(w http.ResponseWriter, r *http.Request) {
	var epic models.Epic
	if err := json.NewDecoder(r.Body).Decode(&epic); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	// Validation
	if epic.StartDate.IsZero() || epic.EndDate.IsZero() {
		http.Error(w, "Start and End dates are required for an Epic", http.StatusBadRequest)
		return
	}

	if result := h.DB.Create(&epic); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusCreated, epic)
}

// PATCH /api/tasks/{id}/toggle
func (h *EpicHandler) ToggleEpicTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// On inverse le booléen is_done pour une EpicTask
	if err := h.DB.Model(&models.EpicTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

// POST /api/epics/{id}/tasks
func (h *EpicHandler) AddTask(w http.ResponseWriter, r *http.Request) {
	epicID := chi.URLParam(r, "id")
	uid, _ := strconv.ParseUint(epicID, 10, 32)

	var task models.EpicTask
	if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	task.EpicID = uint(uid)

	if result := h.DB.Create(&task); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

// Helper partagé
func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

```

## backend/internal/handlers/item_handler.go

```go
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
)

type ItemHandler struct {
	DB *gorm.DB
}

func NewItemHandler(db *gorm.DB) *ItemHandler {
	return &ItemHandler{DB: db}
}

// GET /api/items
func (h *ItemHandler) GetItems(w http.ResponseWriter, r *http.Request) {
	var items []models.Item
	if result := h.DB.Preload("SubTasks").Order("date ASC").Find(&items); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, items)
}

// POST /api/items
func (h *ItemHandler) CreateItem(w http.ResponseWriter, r *http.Request) {
	var item models.Item
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	h.DB.Create(&item)
	respondJSON(w, http.StatusCreated, item)
}

// PUT /api/items/{id} (Nouveau)
func (h *ItemHandler) UpdateItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var item models.Item

	// 1. On vérifie si l'item existe
	if err := h.DB.First(&item, id).Error; err != nil {
		http.Error(w, "Item not found", http.StatusNotFound)
		return
	}

	// 2. On décode les nouvelles données
	var input models.Item
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 3. Mise à jour (Updates ignore les champs zero-value comme "", 0, false)
	// Si tu veux pouvoir remettre à vide, utilise map[string]interface{} ou Save()
	h.DB.Model(&item).Updates(input)

	respondJSON(w, http.StatusOK, item)
}

// DELETE /api/items/{id} (Nouveau)
func (h *ItemHandler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Delete avec GORM (Soft delete si gorm.Model est utilisé, sinon Hard delete)
	if err := h.DB.Delete(&models.Item{}, id).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// PATCH /api/subtasks/{id}/toggle
func (h *ItemHandler) ToggleSubTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	if err := h.DB.Model(&models.SubTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

```

## backend/internal/models/epic.go

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// Epic : Une mission sur la durée (ex: "Nettoyage Printemps")
type Epic struct {
	gorm.Model
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"` // On garde la priorité ici aussi

	// Gestion du temps : Début et Fin explicites
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`

	// Liste de tâches liées à l'épopée
	Tasks []EpicTask `json:"tasks" gorm:"foreignKey:EpicID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`
}

// EpicTask : Une tâche spécifique à une épopée
type EpicTask struct {
	gorm.Model
	EpicID uint   `json:"epic_id"`
	Title  string `json:"title"`
	IsDone bool   `json:"is_done" gorm:"default:false"`
}

```

## backend/internal/models/item.go

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

type Item struct {
	gorm.Model
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Type        string     `json:"type"`
	Status      string     `json:"status" gorm:"default:'TODO'"`
	Date        *time.Time `json:"date"`
	IsRecurring bool       `json:"is_recurring"`
	SubTasks    []SubTask  `json:"sub_tasks" gorm:"constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`

	// Nouveaux champs V1
	Priority    string     `json:"priority"`     // LOW, MEDIUM, HIGH
	PlannedEnd  *time.Time `json:"planned_end"`  // Pour les durées
	ActualStart *time.Time `json:"actual_start"` // Quand j'ai cliqué sur "Doing"
	ActualEnd   *time.Time `json:"actual_end"`   // Quand j'ai cliqué sur "Done"

	// Pour le Drag & Drop (Ordre dans l'inbox)
	SortOrder int `json:"sort_order"`
}

type SubTask struct {
	gorm.Model
	ItemID  uint   `json:"item_id"`
	Content string `json:"content"`
	IsDone  bool   `json:"is_done"`
}

```

## backend/internal/router/router.go

```go
package router

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/sicDANGBE/klaro/internal/handlers"
	"gorm.io/gorm"
)

func Setup(db *gorm.DB) *chi.Mux {
	r := chi.NewRouter()

	// Middlewares
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Initialisation des Handlers
	itemH := handlers.NewItemHandler(db)
	epicH := handlers.NewEpicHandler(db)

	// --- ROUTES API ---
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("OK"))
		})

		// Items
		r.Get("/items", itemH.GetItems)
		r.Post("/items", itemH.CreateItem)
		r.Put("/items/{id}", itemH.UpdateItem)
		r.Delete("/items/{id}", itemH.DeleteItem)
		r.Patch("/subtasks/{id}/toggle", itemH.ToggleSubTask)

		// Epics
		r.Get("/epics", epicH.GetEpics)
		r.Post("/epics", epicH.CreateEpic)
		r.Post("/epics/{id}/tasks", epicH.AddTask)
		r.Patch("/tasks/{id}/toggle", epicH.ToggleEpicTask)
	})

	// --- SERVITUDE FICHIERS STATIQUES (FRONTEND) ---
	// Cette route capture tout ce qui n'est pas /api
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// Dans l'image Docker, le front est copié dans /static
		staticDir := "/static"

		// Si on est en local (pas dans Docker), fallback optionnel (facultatif)
		if _, err := os.Stat(staticDir); os.IsNotExist(err) {
			// En dev local, c'est Vite qui gère, donc on renvoie juste un msg
			w.Write([]byte("Frontend files not found (running in dev mode?)"))
			return
		}

		// Gestion SPA (Single Page App) :
		// Si le fichier demandé n'existe pas (ex: /planner, /dashboard),
		// on renvoie index.html pour que Vue Router gère la route.
		path := filepath.Join(staticDir, r.URL.Path)
		_, err := os.Stat(path)

		if os.IsNotExist(err) || r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}

		// Sinon on sert le fichier (CSS, JS, Logo...)
		http.FileServer(http.Dir(staticDir)).ServeHTTP(w, r)
	})

	return r
}

```

## backend/klaro.db

> Fichier binaire non inclus (40960 octets)

## backend/package.json

```json
{
  "name": "klaro",
  "version": "0.2.1",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "packageManager": "pnpm@10.21.0"
}

```

## backend/plan

```text
📦 Feature A : feat/front-store-epics (La Plomberie)
Objectif : Connecter le Frontend à la nouvelle API Backend sans toucher à l'UI.

Contenu :

Mise à jour des types TypeScript dans stores/klaro.ts (Ajout interfaces Epic, EpicTask).

Ajout des actions Pinia : fetchEpics, createEpic, addEpicTask, toggleEpicTask.

Adaptation des getters pour préparer les données du calendrier.

##############################################################
##############################################################
##############################################################
Prompt:
"Mets à jour le fichier frontend/src/stores/klaro.ts. Je veux intégrer la nouvelle logique Backend Epic (Projets sur la durée) tout en gardant Item (Events ponctuels).

Ajoute les interfaces Epic et EpicTask correspondant aux structs Go.

Ajoute un state epics: ref<Epic[]>([]).

Ajoute les actions fetchEpics, createEpic (POST /api/epics), createEpicTask (POST /api/epics/{id}/tasks) et toggleEpicTask.

Crée un getter calendarRanges qui transforme les Epics en objets utilisables pour l'affichage (avec start, end, couleur, % de progression)."
##############################################################
##############################################################
##############################################################



🎨 Feature B : feat/ui-creation-flow (L'Entrée de données)
Objectif : Permettre à l'utilisateur de choisir entre créer un "Event" (Item simple) ou une "Épopée" (Projet long).

Contenu :

Modification de CreateModal.vue.

Ajout d'un système d'onglets : "Tâche Rapide" (Item) vs "Épopée" (Epic).

Formulaire Épopée : Titre, Description, Date Début et Date Fin obligatoires, Priorité.

Pas de sous-tâches à la création de l'épopée (on crée le contenant d'abord).

Prompt
##############################################################
##############################################################
##############################################################
"Modifie frontend/src/components/CreateModal.vue. Je veux séparer la création en deux modes via des onglets en haut de la modale :

Mode 'Event' (L'existant) : Pour les items simples, ponctuels (Date unique ou Backlog).

Mode 'Épopée' (Nouveau) : Pour les projets longs. Champs Épopée : Titre, Description, Priorité (Low/Med/High), Date de Début et Date de Fin (Obligatoires). Le bouton 'Créer' doit appeler la bonne action du store (createItem ou createEpic) selon l'onglet actif."

##############################################################
##############################################################
##############################################################



📅 Feature C : feat/ui-calendar-epics (La Visualisation)
Objectif : Afficher les Épopées comme des barres continues sur le calendrier (timeline) et gérer leurs tâches.

Contenu :

Vue Mois : Afficher des barres colorées qui traversent les cases des jours (style Gantt simplifié).

Vue Semaine : Afficher une section "Projets en cours" en haut de la grille horaire (comme les "All day events" de Google Calendar).

Détail : Créer EpicDetailModal.vue pour voir l'avancement, ajouter des tâches à l'épopée et les cocher.

Prompt
##############################################################
##############################################################
##############################################################
"Mets à jour frontend/src/App.vue pour afficher les Épopées. Dans la Vue Mois (Grille) :

En plus des items ponctuels (points/textes), affiche les Épopées sous forme de barres horizontales colorées.

Ces barres doivent visuellement commencer à start_date et finir à end_date.

Si une épopée traverse plusieurs semaines, gère l'affichage pour qu'elle apparaisse sur les lignes concernées.

Au clic sur une barre d'épopée, ouvre une nouvelle modale EpicDetailModal (à créer) qui permet d'ajouter/cocher des tâches spécifiques à cette épopée."

##############################################################
##############################################################
##############################################################
```

## backend/pnpm-lock.yaml

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  frontend:
    dependencies:
      '@popperjs/core':
        specifier: ^2.11.8
        version: 2.11.8
      '@tailwindcss/vite':
        specifier: ^4.1.18
        version: 4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))
      pinia:
        specifier: ^3.0.4
        version: 3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      v-calendar:
        specifier: ^3.1.2
        version: 3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3))
      vue:
        specifier: ^3.5.24
        version: 3.5.25(typescript@5.9.3)
    devDependencies:
      '@types/node':
        specifier: ^24.10.1
        version: 24.10.4
      '@vitejs/plugin-vue':
        specifier: ^6.0.1
        version: 6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))
      '@vue/tsconfig':
        specifier: ^0.8.1
        version: 0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      autoprefixer:
        specifier: ^10.4.23
        version: 10.4.23(postcss@8.5.6)
      postcss:
        specifier: ^8.5.6
        version: 8.5.6
      tailwindcss:
        specifier: ^4.1.18
        version: 4.1.18
      typescript:
        specifier: ~5.9.3
        version: 5.9.3
      vite:
        specifier: ^7.2.4
        version: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue-tsc:
        specifier: ^3.1.4
        version: 3.1.8(typescript@5.9.3)

packages:

  '@babel/helper-string-parser@7.27.1':
    resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
    engines: {node: '>=6.9.0'}

  '@babel/helper-validator-identifier@7.28.5':
    resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
    engines: {node: '>=6.9.0'}

  '@babel/parser@7.28.5':
    resolution: {integrity: sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  '@babel/runtime@7.28.4':
    resolution: {integrity: sha512-Q/N6JNWvIvPnLDvjlE1OUBLPQHH6l3CltCEsHIujp45zQUSSh8K+gHnaEX45yAT1nyngnINhvWtzN+Nb9D8RAQ==}
    engines: {node: '>=6.9.0'}

  '@babel/types@7.28.5':
    resolution: {integrity: sha512-qQ5m48eI/MFLQ5PxQj4PFaprjyCTLI37ElWMmNs0K8Lk3dVeOdNpB3ks8jc7yM5CDmVC73eMVk/trk3fgmrUpA==}
    engines: {node: '>=6.9.0'}

  '@esbuild/aix-ppc64@0.27.2':
    resolution: {integrity: sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.27.2':
    resolution: {integrity: sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.27.2':
    resolution: {integrity: sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.27.2':
    resolution: {integrity: sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.27.2':
    resolution: {integrity: sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.27.2':
    resolution: {integrity: sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.27.2':
    resolution: {integrity: sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.27.2':
    resolution: {integrity: sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.27.2':
    resolution: {integrity: sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.27.2':
    resolution: {integrity: sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.27.2':
    resolution: {integrity: sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.27.2':
    resolution: {integrity: sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.27.2':
    resolution: {integrity: sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.27.2':
    resolution: {integrity: sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.27.2':
    resolution: {integrity: sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.27.2':
    resolution: {integrity: sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.27.2':
    resolution: {integrity: sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.27.2':
    resolution: {integrity: sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.27.2':
    resolution: {integrity: sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.27.2':
    resolution: {integrity: sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.27.2':
    resolution: {integrity: sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.27.2':
    resolution: {integrity: sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.27.2':
    resolution: {integrity: sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.27.2':
    resolution: {integrity: sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.27.2':
    resolution: {integrity: sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.27.2':
    resolution: {integrity: sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/gen-mapping@0.3.13':
    resolution: {integrity: sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==}

  '@jridgewell/remapping@2.3.5':
    resolution: {integrity: sha512-LI9u/+laYG4Ds1TDKSJW2YPrIlcVYOwi2fUC6xB43lueCjgxV4lffOCZCtYFiH6TNOX+tQKXx97T4IKHbhyHEQ==}

  '@jridgewell/resolve-uri@3.1.2':
    resolution: {integrity: sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==}
    engines: {node: '>=6.0.0'}

  '@jridgewell/sourcemap-codec@1.5.5':
    resolution: {integrity: sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==}

  '@jridgewell/trace-mapping@0.3.31':
    resolution: {integrity: sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==}

  '@popperjs/core@2.11.8':
    resolution: {integrity: sha512-P1st0aksCrn9sGZhp8GMYwBnQsbvAWsZAX44oXNNvLHGqAOcoVxmjZiohstwQ7SqKnbR47akdNi+uleWD8+g6A==}

  '@rolldown/pluginutils@1.0.0-beta.53':
    resolution: {integrity: sha512-vENRlFU4YbrwVqNDZ7fLvy+JR1CRkyr01jhSiDpE1u6py3OMzQfztQU2jxykW3ALNxO4kSlqIDeYyD0Y9RcQeQ==}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    resolution: {integrity: sha512-iDGS/h7D8t7tvZ1t6+WPK04KD0MwzLZrG0se1hzBjSi5fyxlsiggoJHwh18PCFNn7tG43OWb6pdZ6Y+rMlmyNQ==}
    cpu: [arm]
    os: [android]

  '@rollup/rollup-android-arm64@4.53.5':
    resolution: {integrity: sha512-wrSAViWvZHBMMlWk6EJhvg8/rjxzyEhEdgfMMjREHEq11EtJ6IP6yfcCH57YAEca2Oe3FNCE9DSTgU70EIGmVw==}
    cpu: [arm64]
    os: [android]

  '@rollup/rollup-darwin-arm64@4.53.5':
    resolution: {integrity: sha512-S87zZPBmRO6u1YXQLwpveZm4JfPpAa6oHBX7/ghSiGH3rz/KDgAu1rKdGutV+WUI6tKDMbaBJomhnT30Y2t4VQ==}
    cpu: [arm64]
    os: [darwin]

  '@rollup/rollup-darwin-x64@4.53.5':
    resolution: {integrity: sha512-YTbnsAaHo6VrAczISxgpTva8EkfQus0VPEVJCEaboHtZRIb6h6j0BNxRBOwnDciFTZLDPW5r+ZBmhL/+YpTZgA==}
    cpu: [x64]
    os: [darwin]

  '@rollup/rollup-freebsd-arm64@4.53.5':
    resolution: {integrity: sha512-1T8eY2J8rKJWzaznV7zedfdhD1BqVs1iqILhmHDq/bqCUZsrMt+j8VCTHhP0vdfbHK3e1IQ7VYx3jlKqwlf+vw==}
    cpu: [arm64]
    os: [freebsd]

  '@rollup/rollup-freebsd-x64@4.53.5':
    resolution: {integrity: sha512-sHTiuXyBJApxRn+VFMaw1U+Qsz4kcNlxQ742snICYPrY+DDL8/ZbaC4DVIB7vgZmp3jiDaKA0WpBdP0aqPJoBQ==}
    cpu: [x64]
    os: [freebsd]

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    resolution: {integrity: sha512-dV3T9MyAf0w8zPVLVBptVlzaXxka6xg1f16VAQmjg+4KMSTWDvhimI/Y6mp8oHwNrmnmVl9XxJ/w/mO4uIQONA==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    resolution: {integrity: sha512-wIGYC1x/hyjP+KAu9+ewDI+fi5XSNiUi9Bvg6KGAh2TsNMA3tSEs+Sh6jJ/r4BV/bx/CyWu2ue9kDnIdRyafcQ==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    resolution: {integrity: sha512-Y+qVA0D9d0y2FRNiG9oM3Hut/DgODZbU9I8pLLPwAsU0tUKZ49cyV1tzmB/qRbSzGvY8lpgGkJuMyuhH7Ma+Vg==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    resolution: {integrity: sha512-juaC4bEgJsyFVfqhtGLz8mbopaWD+WeSOYr5E16y+1of6KQjc0BpwZLuxkClqY1i8sco+MdyoXPNiCkQou09+g==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    resolution: {integrity: sha512-rIEC0hZ17A42iXtHX+EPJVL/CakHo+tT7W0pbzdAGuWOt2jxDFh7A/lRhsNHBcqL4T36+UiAgwO8pbmn3dE8wA==}
    cpu: [loong64]
    os: [linux]

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    resolution: {integrity: sha512-T7l409NhUE552RcAOcmJHj3xyZ2h7vMWzcwQI0hvn5tqHh3oSoclf9WgTl+0QqffWFG8MEVZZP1/OBglKZx52Q==}
    cpu: [ppc64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    resolution: {integrity: sha512-7OK5/GhxbnrMcxIFoYfhV/TkknarkYC1hqUw1wU2xUN3TVRLNT5FmBv4KkheSG2xZ6IEbRAhTooTV2+R5Tk0lQ==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    resolution: {integrity: sha512-GwuDBE/PsXaTa76lO5eLJTyr2k8QkPipAyOrs4V/KJufHCZBJ495VCGJol35grx9xryk4V+2zd3Ri+3v7NPh+w==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    resolution: {integrity: sha512-IAE1Ziyr1qNfnmiQLHBURAD+eh/zH1pIeJjeShleII7Vj8kyEm2PF77o+lf3WTHDpNJcu4IXJxNO0Zluro8bOw==}
    cpu: [s390x]
    os: [linux]

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    resolution: {integrity: sha512-Pg6E+oP7GvZ4XwgRJBuSXZjcqpIW3yCBhK4BcsANvb47qMvAbCjR6E+1a/U2WXz1JJxp9/4Dno3/iSJLcm5auw==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.53.5':
    resolution: {integrity: sha512-txGtluxDKTxaMDzUduGP0wdfng24y1rygUMnmlUJ88fzCCULCLn7oE5kb2+tRB+MWq1QDZT6ObT5RrR8HFRKqg==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-openharmony-arm64@4.53.5':
    resolution: {integrity: sha512-3DFiLPnTxiOQV993fMc+KO8zXHTcIjgaInrqlG8zDp1TlhYl6WgrOHuJkJQ6M8zHEcntSJsUp1XFZSY8C1DYbg==}
    cpu: [arm64]
    os: [openharmony]

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    resolution: {integrity: sha512-nggc/wPpNTgjGg75hu+Q/3i32R00Lq1B6N1DO7MCU340MRKL3WZJMjA9U4K4gzy3dkZPXm9E1Nc81FItBVGRlA==}
    cpu: [arm64]
    os: [win32]

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    resolution: {integrity: sha512-U/54pTbdQpPLBdEzCT6NBCFAfSZMvmjr0twhnD9f4EIvlm9wy3jjQ38yQj1AGznrNO65EWQMgm/QUjuIVrYF9w==}
    cpu: [ia32]
    os: [win32]

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    resolution: {integrity: sha512-2NqKgZSuLH9SXBBV2dWNRCZmocgSOx8OJSdpRaEcRlIfX8YrKxUT6z0F1NpvDVhOsl190UFTRh2F2WDWWCYp3A==}
    cpu: [x64]
    os: [win32]

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    resolution: {integrity: sha512-JRpZUhCfhZ4keB5v0fe02gQJy05GqboPOaxvjugW04RLSYYoB/9t2lx2u/tMs/Na/1NXfY8QYjgRljRpN+MjTQ==}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/node@4.1.18':
    resolution: {integrity: sha512-DoR7U1P7iYhw16qJ49fgXUlry1t4CpXeErJHnQ44JgTSKMaZUdf17cfn5mHchfJ4KRBZRFA/Coo+MUF5+gOaCQ==}

  '@tailwindcss/oxide-android-arm64@4.1.18':
    resolution: {integrity: sha512-dJHz7+Ugr9U/diKJA0W6N/6/cjI+ZTAoxPf9Iz9BFRF2GzEX8IvXxFIi/dZBloVJX/MZGvRuFA9rqwdiIEZQ0Q==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [android]

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    resolution: {integrity: sha512-Gc2q4Qhs660bhjyBSKgq6BYvwDz4G+BuyJ5H1xfhmDR3D8HnHCmT/BSkvSL0vQLy/nkMLY20PQ2OoYMO15Jd0A==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [darwin]

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    resolution: {integrity: sha512-FL5oxr2xQsFrc3X9o1fjHKBYBMD1QZNyc1Xzw/h5Qu4XnEBi3dZn96HcHm41c/euGV+GRiXFfh2hUCyKi/e+yw==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [darwin]

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    resolution: {integrity: sha512-Fj+RHgu5bDodmV1dM9yAxlfJwkkWvLiRjbhuO2LEtwtlYlBgiAT4x/j5wQr1tC3SANAgD+0YcmWVrj8R9trVMA==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [freebsd]

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    resolution: {integrity: sha512-Fp+Wzk/Ws4dZn+LV2Nqx3IilnhH51YZoRaYHQsVq3RQvEl+71VGKFpkfHrLM/Li+kt5c0DJe/bHXK1eHgDmdiA==}
    engines: {node: '>= 10'}
    cpu: [arm]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    resolution: {integrity: sha512-S0n3jboLysNbh55Vrt7pk9wgpyTTPD0fdQeh7wQfMqLPM/Hrxi+dVsLsPrycQjGKEQk85Kgbx+6+QnYNiHalnw==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    resolution: {integrity: sha512-1px92582HkPQlaaCkdRcio71p8bc8i/ap5807tPRDK/uw953cauQBT8c5tVGkOwrHMfc2Yh6UuxaH4vtTjGvHg==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    resolution: {integrity: sha512-v3gyT0ivkfBLoZGF9LyHmts0Isc8jHZyVcbzio6Wpzifg/+5ZJpDiRiUhDLkcr7f/r38SWNe7ucxmGW3j3Kb/g==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    resolution: {integrity: sha512-bhJ2y2OQNlcRwwgOAGMY0xTFStt4/wyU6pvI6LSuZpRgKQwxTec0/3Scu91O8ir7qCR3AuepQKLU/kX99FouqQ==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    resolution: {integrity: sha512-LffYTvPjODiP6PT16oNeUQJzNVyJl1cjIebq/rWWBF+3eDst5JGEFSc5cWxyRCJ0Mxl+KyIkqRxk1XPEs9x8TA==}
    engines: {node: '>=14.0.0'}
    cpu: [wasm32]
    bundledDependencies:
      - '@napi-rs/wasm-runtime'
      - '@emnapi/core'
      - '@emnapi/runtime'
      - '@tybys/wasm-util'
      - '@emnapi/wasi-threads'
      - tslib

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    resolution: {integrity: sha512-HjSA7mr9HmC8fu6bdsZvZ+dhjyGCLdotjVOgLA2vEqxEBZaQo9YTX4kwgEvPCpRh8o4uWc4J/wEoFzhEmjvPbA==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [win32]

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    resolution: {integrity: sha512-bJWbyYpUlqamC8dpR7pfjA0I7vdF6t5VpUGMWRkXVE3AXgIZjYUYAK7II1GNaxR8J1SSrSrppRar8G++JekE3Q==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/oxide@4.1.18':
    resolution: {integrity: sha512-EgCR5tTS5bUSKQgzeMClT6iCY3ToqE1y+ZB0AKldj809QXk1Y+3jB0upOYZrn9aGIzPtUsP7sX4QQ4XtjBB95A==}
    engines: {node: '>= 10'}

  '@tailwindcss/vite@4.1.18':
    resolution: {integrity: sha512-jVA+/UpKL1vRLg6Hkao5jldawNmRo7mQYrZtNHMIVpLfLhDml5nMRUo/8MwoX2vNXvnaXNNMedrMfMugAVX1nA==}
    peerDependencies:
      vite: ^5.2.0 || ^6 || ^7

  '@types/estree@1.0.8':
    resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}

  '@types/lodash@4.17.21':
    resolution: {integrity: sha512-FOvQ0YPD5NOfPgMzJihoT+Za5pdkDJWcbpuj1DjaKZIr/gxodQjY/uWEFlTNqW2ugXHUiL8lRQgw63dzKHZdeQ==}

  '@types/node@24.10.4':
    resolution: {integrity: sha512-vnDVpYPMzs4wunl27jHrfmwojOGKya0xyM3sH+UE5iv5uPS6vX7UIoh6m+vQc5LGBq52HBKPIn/zcSZVzeDEZg==}

  '@types/resize-observer-browser@0.1.11':
    resolution: {integrity: sha512-cNw5iH8JkMkb3QkCoe7DaZiawbDQEUX8t7iuQaRTyLOyQCR2h+ibBD4GJt7p5yhUHrlOeL7ZtbxNHeipqNsBzQ==}

  '@vitejs/plugin-vue@6.0.3':
    resolution: {integrity: sha512-TlGPkLFLVOY3T7fZrwdvKpjprR3s4fxRln0ORDo1VQ7HHyxJwTlrjKU3kpVWTlaAjIEuCTokmjkZnr8Tpc925w==}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0
      vue: ^3.2.25

  '@volar/language-core@2.4.26':
    resolution: {integrity: sha512-hH0SMitMxnB43OZpyF1IFPS9bgb2I3bpCh76m2WEK7BE0A0EzpYsRp0CCH2xNKshr7kacU5TQBLYn4zj7CG60A==}

  '@volar/source-map@2.4.26':
    resolution: {integrity: sha512-JJw0Tt/kSFsIRmgTQF4JSt81AUSI1aEye5Zl65EeZ8H35JHnTvFGmpDOBn5iOxd48fyGE+ZvZBp5FcgAy/1Qhw==}

  '@volar/typescript@2.4.26':
    resolution: {integrity: sha512-N87ecLD48Sp6zV9zID/5yuS1+5foj0DfuYGdQ6KHj/IbKvyKv1zNX6VCmnKYwtmHadEO6mFc2EKISiu3RDPAvA==}

  '@vue/compiler-core@3.5.25':
    resolution: {integrity: sha512-vay5/oQJdsNHmliWoZfHPoVZZRmnSWhug0BYT34njkYTPqClh3DNWLkZNJBVSjsNMrg0CCrBfoKkjZQPM/QVUw==}

  '@vue/compiler-dom@3.5.25':
    resolution: {integrity: sha512-4We0OAcMZsKgYoGlMjzYvaoErltdFI2/25wqanuTu+S4gismOTRTBPi4IASOjxWdzIwrYSjnqONfKvuqkXzE2Q==}

  '@vue/compiler-sfc@3.5.25':
    resolution: {integrity: sha512-PUgKp2rn8fFsI++lF2sO7gwO2d9Yj57Utr5yEsDf3GNaQcowCLKL7sf+LvVFvtJDXUp/03+dC6f2+LCv5aK1ag==}

  '@vue/compiler-ssr@3.5.25':
    resolution: {integrity: sha512-ritPSKLBcParnsKYi+GNtbdbrIE1mtuFEJ4U1sWeuOMlIziK5GtOL85t5RhsNy4uWIXPgk+OUdpnXiTdzn8o3A==}

  '@vue/devtools-api@7.7.9':
    resolution: {integrity: sha512-kIE8wvwlcZ6TJTbNeU2HQNtaxLx3a84aotTITUuL/4bzfPxzajGBOoqjMhwZJ8L9qFYDU/lAYMEEm11dnZOD6g==}

  '@vue/devtools-kit@7.7.9':
    resolution: {integrity: sha512-PyQ6odHSgiDVd4hnTP+aDk2X4gl2HmLDfiyEnn3/oV+ckFDuswRs4IbBT7vacMuGdwY/XemxBoh302ctbsptuA==}

  '@vue/devtools-shared@7.7.9':
    resolution: {integrity: sha512-iWAb0v2WYf0QWmxCGy0seZNDPdO3Sp5+u78ORnyeonS6MT4PC7VPrryX2BpMJrwlDeaZ6BD4vP4XKjK0SZqaeA==}

  '@vue/language-core@3.1.8':
    resolution: {integrity: sha512-PfwAW7BLopqaJbneChNL6cUOTL3GL+0l8paYP5shhgY5toBNidWnMXWM+qDwL7MC9+zDtzCF2enT8r6VPu64iw==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  '@vue/reactivity@3.5.25':
    resolution: {integrity: sha512-5xfAypCQepv4Jog1U4zn8cZIcbKKFka3AgWHEFQeK65OW+Ys4XybP6z2kKgws4YB43KGpqp5D/K3go2UPPunLA==}

  '@vue/runtime-core@3.5.25':
    resolution: {integrity: sha512-Z751v203YWwYzy460bzsYQISDfPjHTl+6Zzwo/a3CsAf+0ccEjQ8c+0CdX1WsumRTHeywvyUFtW6KvNukT/smA==}

  '@vue/runtime-dom@3.5.25':
    resolution: {integrity: sha512-a4WrkYFbb19i9pjkz38zJBg8wa/rboNERq3+hRRb0dHiJh13c+6kAbgqCPfMaJ2gg4weWD3APZswASOfmKwamA==}

  '@vue/server-renderer@3.5.25':
    resolution: {integrity: sha512-UJaXR54vMG61i8XNIzTSf2Q7MOqZHpp8+x3XLGtE3+fL+nQd+k7O5+X3D/uWrnQXOdMw5VPih+Uremcw+u1woQ==}
    peerDependencies:
      vue: 3.5.25

  '@vue/shared@3.5.25':
    resolution: {integrity: sha512-AbOPdQQnAnzs58H2FrrDxYj/TJfmeS2jdfEEhgiKINy+bnOANmVizIEgq1r+C5zsbs6l1CCQxtcj71rwNQ4jWg==}

  '@vue/tsconfig@0.8.1':
    resolution: {integrity: sha512-aK7feIWPXFSUhsCP9PFqPyFOcz4ENkb8hZ2pneL6m2UjCkccvaOhC/5KCKluuBufvp2KzkbdA2W2pk20vLzu3g==}
    peerDependencies:
      typescript: 5.x
      vue: ^3.4.0
    peerDependenciesMeta:
      typescript:
        optional: true
      vue:
        optional: true

  alien-signals@3.1.1:
    resolution: {integrity: sha512-ogkIWbVrLwKtHY6oOAXaYkAxP+cTH7V5FZ5+Tm4NZFd8VDZ6uNMDrfzqctTZ42eTMCSR3ne3otpcxmqSnFfPYA==}

  autoprefixer@10.4.23:
    resolution: {integrity: sha512-YYTXSFulfwytnjAPlw8QHncHJmlvFKtczb8InXaAx9Q0LbfDnfEYDE55omerIJKihhmU61Ft+cAOSzQVaBUmeA==}
    engines: {node: ^10 || ^12 || >=14}
    hasBin: true
    peerDependencies:
      postcss: ^8.1.0

  baseline-browser-mapping@2.9.9:
    resolution: {integrity: sha512-V8fbOCSeOFvlDj7LLChUcqbZrdKD9RU/VR260piF1790vT0mfLSwGc/Qzxv3IqiTukOpNtItePa0HBpMAj7MDg==}
    hasBin: true

  birpc@2.9.0:
    resolution: {integrity: sha512-KrayHS5pBi69Xi9JmvoqrIgYGDkD6mcSe/i6YKi3w5kekCLzrX4+nawcXqrj2tIp50Kw/mT/s3p+GVK0A0sKxw==}

  browserslist@4.28.1:
    resolution: {integrity: sha512-ZC5Bd0LgJXgwGqUknZY/vkUQ04r8NXnJZ3yYi4vDmSiZmC/pdSN0NbNRPxZpbtO4uAfDUAFffO8IZoM3Gj8IkA==}
    engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
    hasBin: true

  caniuse-lite@1.0.30001760:
    resolution: {integrity: sha512-7AAMPcueWELt1p3mi13HR/LHH0TJLT11cnwDJEs3xA4+CK/PLKeO9Kl1oru24htkyUKtkGCvAx4ohB0Ttry8Dw==}

  copy-anything@4.0.5:
    resolution: {integrity: sha512-7Vv6asjS4gMOuILabD3l739tsaxFQmC+a7pLZm02zyvs8p977bL3zEgq3yDk5rn9B0PbYgIv++jmHcuUab4RhA==}
    engines: {node: '>=18'}

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  date-fns-tz@2.0.1:
    resolution: {integrity: sha512-fJCG3Pwx8HUoLhkepdsP7Z5RsucUi+ZBOxyM5d0ZZ6c4SdYustq0VMmOu6Wf7bli+yS/Jwp91TOCqn9jMcVrUA==}
    peerDependencies:
      date-fns: 2.x

  date-fns@2.30.0:
    resolution: {integrity: sha512-fnULvOpxnC5/Vg3NCiWelDsLiUc9bRwAPs/+LfTLNvetFCtCTN+yQz15C/fs4AwX1R9K5GLtLfn8QW+dWisaAw==}
    engines: {node: '>=0.11'}

  detect-libc@2.1.2:
    resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
    engines: {node: '>=8'}

  electron-to-chromium@1.5.267:
    resolution: {integrity: sha512-0Drusm6MVRXSOJpGbaSVgcQsuB4hEkMpHXaVstcPmhu5LIedxs1xNK/nIxmQIU/RPC0+1/o0AVZfBTkTNJOdUw==}

  enhanced-resolve@5.18.4:
    resolution: {integrity: sha512-LgQMM4WXU3QI+SYgEc2liRgznaD5ojbmY3sb8LxyguVkIg5FxdpTkvk72te2R38/TGKxH634oLxXRGY6d7AP+Q==}
    engines: {node: '>=10.13.0'}

  entities@4.5.0:
    resolution: {integrity: sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==}
    engines: {node: '>=0.12'}

  esbuild@0.27.2:
    resolution: {integrity: sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==}
    engines: {node: '>=18'}
    hasBin: true

  escalade@3.2.0:
    resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
    engines: {node: '>=6'}

  estree-walker@2.0.2:
    resolution: {integrity: sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==}

  fdir@6.5.0:
    resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
    engines: {node: '>=12.0.0'}
    peerDependencies:
      picomatch: ^3 || ^4
    peerDependenciesMeta:
      picomatch:
        optional: true

  fraction.js@5.3.4:
    resolution: {integrity: sha512-1X1NTtiJphryn/uLQz3whtY6jK3fTqoE3ohKs0tT+Ujr1W59oopxmoEh7Lu5p6vBaPbgoM0bzveAW4Qi5RyWDQ==}

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  graceful-fs@4.2.11:
    resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}

  hookable@5.5.3:
    resolution: {integrity: sha512-Yc+BQe8SvoXH1643Qez1zqLRmbA5rCL+sSmk6TVos0LWVfNIB7PGncdlId77WzLGSIB5KaWgTaNTs2lNVEI6VQ==}

  is-what@5.5.0:
    resolution: {integrity: sha512-oG7cgbmg5kLYae2N5IVd3jm2s+vldjxJzK1pcu9LfpGuQ93MQSzo0okvRna+7y5ifrD+20FE8FvjusyGaz14fw==}
    engines: {node: '>=18'}

  jiti@2.6.1:
    resolution: {integrity: sha512-ekilCSN1jwRvIbgeg/57YFh8qQDNbwDb9xT/qu2DAHbFFZUicIl4ygVaAvzveMhMVr3LnpSKTNnwt8PoOfmKhQ==}
    hasBin: true

  lightningcss-android-arm64@1.30.2:
    resolution: {integrity: sha512-BH9sEdOCahSgmkVhBLeU7Hc9DWeZ1Eb6wNS6Da8igvUwAe0sqROHddIlvU06q3WyXVEOYDZ6ykBZQnjTbmo4+A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [android]

  lightningcss-darwin-arm64@1.30.2:
    resolution: {integrity: sha512-ylTcDJBN3Hp21TdhRT5zBOIi73P6/W0qwvlFEk22fkdXchtNTOU4Qc37SkzV+EKYxLouZ6M4LG9NfZ1qkhhBWA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [darwin]

  lightningcss-darwin-x64@1.30.2:
    resolution: {integrity: sha512-oBZgKchomuDYxr7ilwLcyms6BCyLn0z8J0+ZZmfpjwg9fRVZIR5/GMXd7r9RH94iDhld3UmSjBM6nXWM2TfZTQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [darwin]

  lightningcss-freebsd-x64@1.30.2:
    resolution: {integrity: sha512-c2bH6xTrf4BDpK8MoGG4Bd6zAMZDAXS569UxCAGcA7IKbHNMlhGQ89eRmvpIUGfKWNVdbhSbkQaWhEoMGmGslA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [freebsd]

  lightningcss-linux-arm-gnueabihf@1.30.2:
    resolution: {integrity: sha512-eVdpxh4wYcm0PofJIZVuYuLiqBIakQ9uFZmipf6LF/HRj5Bgm0eb3qL/mr1smyXIS1twwOxNWndd8z0E374hiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm]
    os: [linux]

  lightningcss-linux-arm64-gnu@1.30.2:
    resolution: {integrity: sha512-UK65WJAbwIJbiBFXpxrbTNArtfuznvxAJw4Q2ZGlU8kPeDIWEX1dg3rn2veBVUylA2Ezg89ktszWbaQnxD/e3A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-arm64-musl@1.30.2:
    resolution: {integrity: sha512-5Vh9dGeblpTxWHpOx8iauV02popZDsCYMPIgiuw97OJ5uaDsL86cnqSFs5LZkG3ghHoX5isLgWzMs+eD1YzrnA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-x64-gnu@1.30.2:
    resolution: {integrity: sha512-Cfd46gdmj1vQ+lR6VRTTadNHu6ALuw2pKR9lYq4FnhvgBc4zWY1EtZcAc6EffShbb1MFrIPfLDXD6Xprbnni4w==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-linux-x64-musl@1.30.2:
    resolution: {integrity: sha512-XJaLUUFXb6/QG2lGIW6aIk6jKdtjtcffUT0NKvIqhSBY3hh9Ch+1LCeH80dR9q9LBjG3ewbDjnumefsLsP6aiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-win32-arm64-msvc@1.30.2:
    resolution: {integrity: sha512-FZn+vaj7zLv//D/192WFFVA0RgHawIcHqLX9xuWiQt7P0PtdFEVaxgF9rjM/IRYHQXNnk61/H/gb2Ei+kUQ4xQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [win32]

  lightningcss-win32-x64-msvc@1.30.2:
    resolution: {integrity: sha512-5g1yc73p+iAkid5phb4oVFMB45417DkRevRbt/El/gKXJk4jid+vPFF/AXbxn05Aky8PapwzZrdJShv5C0avjw==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [win32]

  lightningcss@1.30.2:
    resolution: {integrity: sha512-utfs7Pr5uJyyvDETitgsaqSyjCb2qNRAtuqUeWIAKztsOYdcACf2KtARYXg2pSvhkt+9NfoaNY7fxjl6nuMjIQ==}
    engines: {node: '>= 12.0.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}

  magic-string@0.30.21:
    resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}

  mitt@3.0.1:
    resolution: {integrity: sha512-vKivATfr97l2/QBCYAkXYDbrIWPM2IIKEl7YPhjCvKlG3kE2gm+uBo6nEXK3M5/Ffh/FLpKExzOQ3JJoJGFKBw==}

  muggle-string@0.4.1:
    resolution: {integrity: sha512-VNTrAak/KhO2i8dqqnqnAHOa3cYBwXEZe9h+D5h/1ZqFSTEFHdM65lR7RoIqq3tBBYavsOXV84NoHXZ0AkPyqQ==}

  nanoid@3.3.11:
    resolution: {integrity: sha512-N8SpfPUnUp1bK+PMYW8qSWdl9U+wwNWI4QKxOYDy9JAro3WMX7p2OeVRF9v+347pnakNevPmiHhNmZ2HbFA76w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  node-releases@2.0.27:
    resolution: {integrity: sha512-nmh3lCkYZ3grZvqcCH+fjmQ7X+H0OeZgP40OierEaAptX4XofMh5kwNbWh7lBduUzCcV/8kZ+NDLCwm2iorIlA==}

  path-browserify@1.0.1:
    resolution: {integrity: sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==}

  perfect-debounce@1.0.0:
    resolution: {integrity: sha512-xCy9V055GLEqoFaHoC1SoLIaLmWctgCUaBaWxDZ7/Zx4CTyX7cJQLJOok/orfjZAh9kEYpjJa4d0KcJmCbctZA==}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  picomatch@4.0.3:
    resolution: {integrity: sha512-5gTmgEY/sqK6gFXLIsQNH19lWb4ebPDLA4SdLP7dsWkIXHWlG66oPuVvXSGFPppYZz8ZDZq0dYYrbHfBCVUb1Q==}
    engines: {node: '>=12'}

  pinia@3.0.4:
    resolution: {integrity: sha512-l7pqLUFTI/+ESXn6k3nu30ZIzW5E2WZF/LaHJEpoq6ElcLD+wduZoB2kBN19du6K/4FDpPMazY2wJr+IndBtQw==}
    peerDependencies:
      typescript: '>=4.5.0'
      vue: ^3.5.11
    peerDependenciesMeta:
      typescript:
        optional: true

  postcss-value-parser@4.2.0:
    resolution: {integrity: sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==}

  postcss@8.5.6:
    resolution: {integrity: sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==}
    engines: {node: ^10 || ^12 || >=14}

  rfdc@1.4.1:
    resolution: {integrity: sha512-q1b3N5QkRUWUl7iyylaaj3kOpIT0N2i9MqIEQXP73GVsN9cw3fdx8X63cEmWhJGi2PPCF23Ijp7ktmd39rawIA==}

  rollup@4.53.5:
    resolution: {integrity: sha512-iTNAbFSlRpcHeeWu73ywU/8KuU/LZmNCSxp6fjQkJBD3ivUb8tpDrXhIxEzA05HlYMEwmtaUnb3RP+YNv162OQ==}
    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
    hasBin: true

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  speakingurl@14.0.1:
    resolution: {integrity: sha512-1POYv7uv2gXoyGFpBCmpDVSNV74IfsWlDW216UPjbWufNf+bSU6GdbDsxdcxtfwb4xlI3yxzOTKClUosxARYrQ==}
    engines: {node: '>=0.10.0'}

  superjson@2.2.6:
    resolution: {integrity: sha512-H+ue8Zo4vJmV2nRjpx86P35lzwDT3nItnIsocgumgr0hHMQ+ZGq5vrERg9kJBo5AWGmxZDhzDo+WVIJqkB0cGA==}
    engines: {node: '>=16'}

  tailwindcss@4.1.18:
    resolution: {integrity: sha512-4+Z+0yiYyEtUVCScyfHCxOYP06L5Ne+JiHhY2IjR2KWMIWhJOYZKLSGZaP5HkZ8+bY0cxfzwDE5uOmzFXyIwxw==}

  tapable@2.3.0:
    resolution: {integrity: sha512-g9ljZiwki/LfxmQADO3dEY1CbpmXT5Hm2fJ+QaGKwSXUylMybePR7/67YW7jOrrvjEgL1Fmz5kzyAjWVWLlucg==}
    engines: {node: '>=6'}

  tinyglobby@0.2.15:
    resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
    engines: {node: '>=12.0.0'}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.16.0:
    resolution: {integrity: sha512-Zz+aZWSj8LE6zoxD+xrjh4VfkIG8Ya6LvYkZqtUQGJPZjYl53ypCaUwWqo7eI0x66KBGeRo+mlBEkMSeSZ38Nw==}

  update-browserslist-db@1.2.3:
    resolution: {integrity: sha512-Js0m9cx+qOgDxo0eMiFGEueWztz+d4+M3rGlmKPT+T4IS/jP4ylw3Nwpu6cpTTP8R1MAC1kF4VbdLt3ARf209w==}
    hasBin: true
    peerDependencies:
      browserslist: '>= 4.21.0'

  v-calendar@3.1.2:
    resolution: {integrity: sha512-QDWrnp4PWCpzUblctgo4T558PrHgHzDtQnTeUNzKxfNf29FkCeFpwGd9bKjAqktaa2aJLcyRl45T5ln1ku34kg==}
    peerDependencies:
      '@popperjs/core': ^2.0.0
      vue: ^3.2.0

  vite@7.3.0:
    resolution: {integrity: sha512-dZwN5L1VlUBewiP6H9s2+B3e3Jg96D0vzN+Ry73sOefebhYr9f94wwkMNN/9ouoU8pV1BqA1d1zGk8928cx0rg==}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true
    peerDependencies:
      '@types/node': ^20.19.0 || >=22.12.0
      jiti: '>=1.21.0'
      less: ^4.0.0
      lightningcss: ^1.21.0
      sass: ^1.70.0
      sass-embedded: ^1.70.0
      stylus: '>=0.54.8'
      sugarss: ^5.0.0
      terser: ^5.16.0
      tsx: ^4.8.1
      yaml: ^2.4.2
    peerDependenciesMeta:
      '@types/node':
        optional: true
      jiti:
        optional: true
      less:
        optional: true
      lightningcss:
        optional: true
      sass:
        optional: true
      sass-embedded:
        optional: true
      stylus:
        optional: true
      sugarss:
        optional: true
      terser:
        optional: true
      tsx:
        optional: true
      yaml:
        optional: true

  vscode-uri@3.1.0:
    resolution: {integrity: sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==}

  vue-screen-utils@1.0.0-beta.13:
    resolution: {integrity: sha512-EJ/8TANKhFj+LefDuOvZykwMr3rrLFPLNb++lNBqPOpVigT2ActRg6icH9RFQVm4nHwlHIHSGm5OY/Clar9yIg==}
    peerDependencies:
      vue: ^3.2.0

  vue-tsc@3.1.8:
    resolution: {integrity: sha512-deKgwx6exIHeZwF601P1ktZKNF0bepaSN4jBU3AsbldPx9gylUc1JDxYppl82yxgkAgaz0Y0LCLOi+cXe9HMYA==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vue@3.5.25:
    resolution: {integrity: sha512-YLVdgv2K13WJ6n+kD5owehKtEXwdwXuj2TTyJMsO7pSeKw2bfRNZGjhB7YzrpbMYj5b5QsUebHpOqR3R3ziy/g==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

snapshots:

  '@babel/helper-string-parser@7.27.1': {}

  '@babel/helper-validator-identifier@7.28.5': {}

  '@babel/parser@7.28.5':
    dependencies:
      '@babel/types': 7.28.5

  '@babel/runtime@7.28.4': {}

  '@babel/types@7.28.5':
    dependencies:
      '@babel/helper-string-parser': 7.27.1
      '@babel/helper-validator-identifier': 7.28.5

  '@esbuild/aix-ppc64@0.27.2':
    optional: true

  '@esbuild/android-arm64@0.27.2':
    optional: true

  '@esbuild/android-arm@0.27.2':
    optional: true

  '@esbuild/android-x64@0.27.2':
    optional: true

  '@esbuild/darwin-arm64@0.27.2':
    optional: true

  '@esbuild/darwin-x64@0.27.2':
    optional: true

  '@esbuild/freebsd-arm64@0.27.2':
    optional: true

  '@esbuild/freebsd-x64@0.27.2':
    optional: true

  '@esbuild/linux-arm64@0.27.2':
    optional: true

  '@esbuild/linux-arm@0.27.2':
    optional: true

  '@esbuild/linux-ia32@0.27.2':
    optional: true

  '@esbuild/linux-loong64@0.27.2':
    optional: true

  '@esbuild/linux-mips64el@0.27.2':
    optional: true

  '@esbuild/linux-ppc64@0.27.2':
    optional: true

  '@esbuild/linux-riscv64@0.27.2':
    optional: true

  '@esbuild/linux-s390x@0.27.2':
    optional: true

  '@esbuild/linux-x64@0.27.2':
    optional: true

  '@esbuild/netbsd-arm64@0.27.2':
    optional: true

  '@esbuild/netbsd-x64@0.27.2':
    optional: true

  '@esbuild/openbsd-arm64@0.27.2':
    optional: true

  '@esbuild/openbsd-x64@0.27.2':
    optional: true

  '@esbuild/openharmony-arm64@0.27.2':
    optional: true

  '@esbuild/sunos-x64@0.27.2':
    optional: true

  '@esbuild/win32-arm64@0.27.2':
    optional: true

  '@esbuild/win32-ia32@0.27.2':
    optional: true

  '@esbuild/win32-x64@0.27.2':
    optional: true

  '@jridgewell/gen-mapping@0.3.13':
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/remapping@2.3.5':
    dependencies:
      '@jridgewell/gen-mapping': 0.3.13
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/resolve-uri@3.1.2': {}

  '@jridgewell/sourcemap-codec@1.5.5': {}

  '@jridgewell/trace-mapping@0.3.31':
    dependencies:
      '@jridgewell/resolve-uri': 3.1.2
      '@jridgewell/sourcemap-codec': 1.5.5

  '@popperjs/core@2.11.8': {}

  '@rolldown/pluginutils@1.0.0-beta.53': {}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    optional: true

  '@rollup/rollup-android-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-x64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-arm64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-x64@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-musl@4.53.5':
    optional: true

  '@rollup/rollup-openharmony-arm64@4.53.5':
    optional: true

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    optional: true

  '@tailwindcss/node@4.1.18':
    dependencies:
      '@jridgewell/remapping': 2.3.5
      enhanced-resolve: 5.18.4
      jiti: 2.6.1
      lightningcss: 1.30.2
      magic-string: 0.30.21
      source-map-js: 1.2.1
      tailwindcss: 4.1.18

  '@tailwindcss/oxide-android-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide@4.1.18':
    optionalDependencies:
      '@tailwindcss/oxide-android-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-x64': 4.1.18
      '@tailwindcss/oxide-freebsd-x64': 4.1.18
      '@tailwindcss/oxide-linux-arm-gnueabihf': 4.1.18
      '@tailwindcss/oxide-linux-arm64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-arm64-musl': 4.1.18
      '@tailwindcss/oxide-linux-x64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-x64-musl': 4.1.18
      '@tailwindcss/oxide-wasm32-wasi': 4.1.18
      '@tailwindcss/oxide-win32-arm64-msvc': 4.1.18
      '@tailwindcss/oxide-win32-x64-msvc': 4.1.18

  '@tailwindcss/vite@4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))':
    dependencies:
      '@tailwindcss/node': 4.1.18
      '@tailwindcss/oxide': 4.1.18
      tailwindcss: 4.1.18
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)

  '@types/estree@1.0.8': {}

  '@types/lodash@4.17.21': {}

  '@types/node@24.10.4':
    dependencies:
      undici-types: 7.16.0

  '@types/resize-observer-browser@0.1.11': {}

  '@vitejs/plugin-vue@6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@rolldown/pluginutils': 1.0.0-beta.53
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue: 3.5.25(typescript@5.9.3)

  '@volar/language-core@2.4.26':
    dependencies:
      '@volar/source-map': 2.4.26

  '@volar/source-map@2.4.26': {}

  '@volar/typescript@2.4.26':
    dependencies:
      '@volar/language-core': 2.4.26
      path-browserify: 1.0.1
      vscode-uri: 3.1.0

  '@vue/compiler-core@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/shared': 3.5.25
      entities: 4.5.0
      estree-walker: 2.0.2
      source-map-js: 1.2.1

  '@vue/compiler-dom@3.5.25':
    dependencies:
      '@vue/compiler-core': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/compiler-sfc@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/compiler-core': 3.5.25
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      estree-walker: 2.0.2
      magic-string: 0.30.21
      postcss: 8.5.6
      source-map-js: 1.2.1

  '@vue/compiler-ssr@3.5.25':
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/devtools-api@7.7.9':
    dependencies:
      '@vue/devtools-kit': 7.7.9

  '@vue/devtools-kit@7.7.9':
    dependencies:
      '@vue/devtools-shared': 7.7.9
      birpc: 2.9.0
      hookable: 5.5.3
      mitt: 3.0.1
      perfect-debounce: 1.0.0
      speakingurl: 14.0.1
      superjson: 2.2.6

  '@vue/devtools-shared@7.7.9':
    dependencies:
      rfdc: 1.4.1

  '@vue/language-core@3.1.8(typescript@5.9.3)':
    dependencies:
      '@volar/language-core': 2.4.26
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25
      alien-signals: 3.1.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.3
    optionalDependencies:
      typescript: 5.9.3

  '@vue/reactivity@3.5.25':
    dependencies:
      '@vue/shared': 3.5.25

  '@vue/runtime-core@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/runtime-dom@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/runtime-core': 3.5.25
      '@vue/shared': 3.5.25
      csstype: 3.2.3

  '@vue/server-renderer@3.5.25(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      vue: 3.5.25(typescript@5.9.3)

  '@vue/shared@3.5.25': {}

  '@vue/tsconfig@0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))':
    optionalDependencies:
      typescript: 5.9.3
      vue: 3.5.25(typescript@5.9.3)

  alien-signals@3.1.1: {}

  autoprefixer@10.4.23(postcss@8.5.6):
    dependencies:
      browserslist: 4.28.1
      caniuse-lite: 1.0.30001760
      fraction.js: 5.3.4
      picocolors: 1.1.1
      postcss: 8.5.6
      postcss-value-parser: 4.2.0

  baseline-browser-mapping@2.9.9: {}

  birpc@2.9.0: {}

  browserslist@4.28.1:
    dependencies:
      baseline-browser-mapping: 2.9.9
      caniuse-lite: 1.0.30001760
      electron-to-chromium: 1.5.267
      node-releases: 2.0.27
      update-browserslist-db: 1.2.3(browserslist@4.28.1)

  caniuse-lite@1.0.30001760: {}

  copy-anything@4.0.5:
    dependencies:
      is-what: 5.5.0

  csstype@3.2.3: {}

  date-fns-tz@2.0.1(date-fns@2.30.0):
    dependencies:
      date-fns: 2.30.0

  date-fns@2.30.0:
    dependencies:
      '@babel/runtime': 7.28.4

  detect-libc@2.1.2: {}

  electron-to-chromium@1.5.267: {}

  enhanced-resolve@5.18.4:
    dependencies:
      graceful-fs: 4.2.11
      tapable: 2.3.0

  entities@4.5.0: {}

  esbuild@0.27.2:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.27.2
      '@esbuild/android-arm': 0.27.2
      '@esbuild/android-arm64': 0.27.2
      '@esbuild/android-x64': 0.27.2
      '@esbuild/darwin-arm64': 0.27.2
      '@esbuild/darwin-x64': 0.27.2
      '@esbuild/freebsd-arm64': 0.27.2
      '@esbuild/freebsd-x64': 0.27.2
      '@esbuild/linux-arm': 0.27.2
      '@esbuild/linux-arm64': 0.27.2
      '@esbuild/linux-ia32': 0.27.2
      '@esbuild/linux-loong64': 0.27.2
      '@esbuild/linux-mips64el': 0.27.2
      '@esbuild/linux-ppc64': 0.27.2
      '@esbuild/linux-riscv64': 0.27.2
      '@esbuild/linux-s390x': 0.27.2
      '@esbuild/linux-x64': 0.27.2
      '@esbuild/netbsd-arm64': 0.27.2
      '@esbuild/netbsd-x64': 0.27.2
      '@esbuild/openbsd-arm64': 0.27.2
      '@esbuild/openbsd-x64': 0.27.2
      '@esbuild/openharmony-arm64': 0.27.2
      '@esbuild/sunos-x64': 0.27.2
      '@esbuild/win32-arm64': 0.27.2
      '@esbuild/win32-ia32': 0.27.2
      '@esbuild/win32-x64': 0.27.2

  escalade@3.2.0: {}

  estree-walker@2.0.2: {}

  fdir@6.5.0(picomatch@4.0.3):
    optionalDependencies:
      picomatch: 4.0.3

  fraction.js@5.3.4: {}

  fsevents@2.3.3:
    optional: true

  graceful-fs@4.2.11: {}

  hookable@5.5.3: {}

  is-what@5.5.0: {}

  jiti@2.6.1: {}

  lightningcss-android-arm64@1.30.2:
    optional: true

  lightningcss-darwin-arm64@1.30.2:
    optional: true

  lightningcss-darwin-x64@1.30.2:
    optional: true

  lightningcss-freebsd-x64@1.30.2:
    optional: true

  lightningcss-linux-arm-gnueabihf@1.30.2:
    optional: true

  lightningcss-linux-arm64-gnu@1.30.2:
    optional: true

  lightningcss-linux-arm64-musl@1.30.2:
    optional: true

  lightningcss-linux-x64-gnu@1.30.2:
    optional: true

  lightningcss-linux-x64-musl@1.30.2:
    optional: true

  lightningcss-win32-arm64-msvc@1.30.2:
    optional: true

  lightningcss-win32-x64-msvc@1.30.2:
    optional: true

  lightningcss@1.30.2:
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      lightningcss-android-arm64: 1.30.2
      lightningcss-darwin-arm64: 1.30.2
      lightningcss-darwin-x64: 1.30.2
      lightningcss-freebsd-x64: 1.30.2
      lightningcss-linux-arm-gnueabihf: 1.30.2
      lightningcss-linux-arm64-gnu: 1.30.2
      lightningcss-linux-arm64-musl: 1.30.2
      lightningcss-linux-x64-gnu: 1.30.2
      lightningcss-linux-x64-musl: 1.30.2
      lightningcss-win32-arm64-msvc: 1.30.2
      lightningcss-win32-x64-msvc: 1.30.2

  lodash@4.17.21: {}

  magic-string@0.30.21:
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5

  mitt@3.0.1: {}

  muggle-string@0.4.1: {}

  nanoid@3.3.11: {}

  node-releases@2.0.27: {}

  path-browserify@1.0.1: {}

  perfect-debounce@1.0.0: {}

  picocolors@1.1.1: {}

  picomatch@4.0.3: {}

  pinia@3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@vue/devtools-api': 7.7.9
      vue: 3.5.25(typescript@5.9.3)
    optionalDependencies:
      typescript: 5.9.3

  postcss-value-parser@4.2.0: {}

  postcss@8.5.6:
    dependencies:
      nanoid: 3.3.11
      picocolors: 1.1.1
      source-map-js: 1.2.1

  rfdc@1.4.1: {}

  rollup@4.53.5:
    dependencies:
      '@types/estree': 1.0.8
    optionalDependencies:
      '@rollup/rollup-android-arm-eabi': 4.53.5
      '@rollup/rollup-android-arm64': 4.53.5
      '@rollup/rollup-darwin-arm64': 4.53.5
      '@rollup/rollup-darwin-x64': 4.53.5
      '@rollup/rollup-freebsd-arm64': 4.53.5
      '@rollup/rollup-freebsd-x64': 4.53.5
      '@rollup/rollup-linux-arm-gnueabihf': 4.53.5
      '@rollup/rollup-linux-arm-musleabihf': 4.53.5
      '@rollup/rollup-linux-arm64-gnu': 4.53.5
      '@rollup/rollup-linux-arm64-musl': 4.53.5
      '@rollup/rollup-linux-loong64-gnu': 4.53.5
      '@rollup/rollup-linux-ppc64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-musl': 4.53.5
      '@rollup/rollup-linux-s390x-gnu': 4.53.5
      '@rollup/rollup-linux-x64-gnu': 4.53.5
      '@rollup/rollup-linux-x64-musl': 4.53.5
      '@rollup/rollup-openharmony-arm64': 4.53.5
      '@rollup/rollup-win32-arm64-msvc': 4.53.5
      '@rollup/rollup-win32-ia32-msvc': 4.53.5
      '@rollup/rollup-win32-x64-gnu': 4.53.5
      '@rollup/rollup-win32-x64-msvc': 4.53.5
      fsevents: 2.3.3

  source-map-js@1.2.1: {}

  speakingurl@14.0.1: {}

  superjson@2.2.6:
    dependencies:
      copy-anything: 4.0.5

  tailwindcss@4.1.18: {}

  tapable@2.3.0: {}

  tinyglobby@0.2.15:
    dependencies:
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3

  typescript@5.9.3: {}

  undici-types@7.16.0: {}

  update-browserslist-db@1.2.3(browserslist@4.28.1):
    dependencies:
      browserslist: 4.28.1
      escalade: 3.2.0
      picocolors: 1.1.1

  v-calendar@3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@popperjs/core': 2.11.8
      '@types/lodash': 4.17.21
      '@types/resize-observer-browser': 0.1.11
      date-fns: 2.30.0
      date-fns-tz: 2.0.1(date-fns@2.30.0)
      lodash: 4.17.21
      vue: 3.5.25(typescript@5.9.3)
      vue-screen-utils: 1.0.0-beta.13(vue@3.5.25(typescript@5.9.3))

  vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2):
    dependencies:
      esbuild: 0.27.2
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3
      postcss: 8.5.6
      rollup: 4.53.5
      tinyglobby: 0.2.15
    optionalDependencies:
      '@types/node': 24.10.4
      fsevents: 2.3.3
      jiti: 2.6.1
      lightningcss: 1.30.2

  vscode-uri@3.1.0: {}

  vue-screen-utils@1.0.0-beta.13(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      vue: 3.5.25(typescript@5.9.3)

  vue-tsc@3.1.8(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.26
      '@vue/language-core': 3.1.8(typescript@5.9.3)
      typescript: 5.9.3

  vue@3.5.25(typescript@5.9.3):
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-sfc': 3.5.25
      '@vue/runtime-dom': 3.5.25
      '@vue/server-renderer': 3.5.25(vue@3.5.25(typescript@5.9.3))
      '@vue/shared': 3.5.25
    optionalDependencies:
      typescript: 5.9.3

```

## backend/pnpm-workspace.yaml

```yaml
packages:
  - 'frontend'
  - 'backend'

```

## backend/project_export.log

```text
[2025-12-18 23:46:44] Source  : .
[2025-12-18 23:46:44] Sortie  : project_export.md
[2025-12-18 23:46:44] Fichiers trouvés (avant filtre): 13245
[2025-12-18 23:46:45] Fichiers à concaténer (après filtre): 46 (exclus auto:3 dir:13192 file:4)
[2025-12-18 23:46:45] Concatène [1] .github/workflows/pull_request.yml (size=883)
[2025-12-18 23:46:45] Concatène [2] .github/workflows/release.yml (size=2609)
[2025-12-18 23:46:45] Concatène [3] .gitignore (size=282)
[2025-12-18 23:46:45] Concatène [4] Dockerfile (size=2895)
[2025-12-18 23:46:45] Concatène [5] Makefile (size=3247)
[2025-12-18 23:46:45] Concatène [6] backend/.air.toml (size=598)
[2025-12-18 23:46:45] Concatène [7] backend/api/handlers.go (size=4301)
[2025-12-18 23:46:45] Concatène [8] backend/cmd/server/main.go (size=540)
[2025-12-18 23:46:45] Concatène [9] backend/go.mod (size=791)
[2025-12-18 23:46:45] Concatène [10] backend/go.sum (size=3296)
[2025-12-18 23:46:45] Concatène [11] backend/internal/database/db.go (size=853)
[2025-12-18 23:46:45] Concatène [12] backend/internal/handlers/epic_handler.go (size=2472)
[2025-12-18 23:46:45] Concatène [13] backend/internal/handlers/item_handler.go (size=2480)
[2025-12-18 23:46:45] Concatène [14] backend/internal/models/epic.go (size=781)
[2025-12-18 23:46:45] Concatène [15] backend/internal/models/item.go (size=983)
[2025-12-18 23:46:45] Concatène [16] backend/internal/router/router.go (size=2361)
[2025-12-18 23:46:45] ℹ️  Binaire : backend/klaro.db — référencé mais non inclus
[2025-12-18 23:46:45] Concatène [18] backend/store/schema.go (size=2835)
[2025-12-18 23:46:45] ℹ️  Binaire : backend/tmp/main — référencé mais non inclus
[2025-12-18 23:46:45] Concatène [20] documentation/RELEASE_PROCESS.md (size=5637)
[2025-12-18 23:46:45] Concatène [21] frontend/.gitignore (size=253)
[2025-12-18 23:46:45] Concatène [22] frontend/.vscode/extensions.json (size=39)
[2025-12-18 23:46:45] Concatène [23] frontend/README.md (size=442)
[2025-12-18 23:46:45] Concatène [24] frontend/index.html (size=617)
[2025-12-18 23:46:45] Concatène [25] frontend/package.json (size=649)
[2025-12-18 23:46:45] Concatène [26] frontend/pnpm-lock.yaml (size=29270)
[2025-12-18 23:46:45] Concatène [27] frontend/src/App.vue (size=20108)
[2025-12-18 23:46:45] Concatène [28] frontend/src/components/CreateModal.vue (size=10559)
[2025-12-18 23:46:45] Concatène [29] frontend/src/components/DashboardView.vue (size=6511)
[2025-12-18 23:46:45] Concatène [30] frontend/src/components/DetailModal.vue (size=3828)
[2025-12-18 23:46:45] Concatène [31] frontend/src/components/EditModal.vue (size=8242)
[2025-12-18 23:46:45] Concatène [32] frontend/src/components/HelloWorld.vue (size=856)
[2025-12-18 23:46:45] Concatène [33] frontend/src/main.ts (size=495)
[2025-12-18 23:46:45] Concatène [34] frontend/src/stores/klaro.ts (size=7365)
[2025-12-18 23:46:45] Concatène [35] frontend/src/style.css (size=3598)
[2025-12-18 23:46:45] Concatène [36] frontend/tsconfig.app.json (size=454)
[2025-12-18 23:46:45] Concatène [37] frontend/tsconfig.json (size=119)
[2025-12-18 23:46:45] Concatène [38] frontend/tsconfig.node.json (size=653)
[2025-12-18 23:46:45] Concatène [39] frontend/vite.config.ts (size=213)
[2025-12-18 23:46:45] Concatène [40] k8s/deployment.yaml (size=1220)
[2025-12-18 23:46:45] Concatène [41] k8s/ingress.yaml (size=608)
[2025-12-18 23:46:45] Concatène [42] k8s/service.yaml (size=170)
[2025-12-18 23:46:45] Concatène [43] package.json (size=255)
[2025-12-18 23:46:45] Concatène [44] plan (size=4170)
[2025-12-18 23:46:45] Concatène [45] pnpm-lock.yaml (size=49940)
[2025-12-18 23:46:45] Concatène [46] pnpm-workspace.yaml (size=39)
[2025-12-18 23:46:45] Concaténation Markdown terminée : 44 fichier(s), 188517 octets.
[2025-12-18 23:46:45] Aucune règle d’anonymisation — étape sautée.
[2025-12-18 23:46:45] Terminé. Log détaillé: project_export.log

```

## backend/project_export.md

`````markdown
# Export de projet

_Généré le 2025-12-18T23:46:45+01:00_

## .github/workflows/pull_request.yml

```yaml
name: CI - Quality Check

on:
  push:
    branches: [ "main" ]
  pull_request:
    branches: [ "main" ]

jobs:
  test-and-build-check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 1. Tests Frontend
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install & Type Check Frontend
        run: |
          cd frontend
          corepack enable
          pnpm install
          pnpm build # Vérifie que le front compile sans erreur TS

      # 2. Tests Backend
      - name: Setup Go
        uses: actions/setup-go@v5
        with:
          go-version: '1.23' # Ou ta version
      - name: Test Backend
        run: |
          cd backend
          go test ./... 

      # 3. Dry Run Docker (On build mais on ne push pas)
      - name: Verify Docker Build
        run: docker build .
```

## .github/workflows/release.yml

```yaml
name: Build & Release (Tag Only)

on:
  push:
    tags:
      - 'v*' # Se déclenche UNIQUEMENT si le push est un tag (ex: v1.0.1)

env:
  IMAGE_NAME: spadmdck/klaro

jobs:
  build-release-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: write # Pour créer la Release GitHub
    
    steps:
      - uses: actions/checkout@v4

      # 1. Récupération de la version depuis package.json
      # C'est la source de vérité.
      - name: Extract version
        id: version
        run: |
          VERSION=$(jq -r .version package.json)
          # Vérification de sécurité : Le tag Git DOIT matcher le package.json
          # Si tu as tagué v1.0.1 mais que le json dit 1.0.0, ça coupe.
          if [[ "v$VERSION" != "${{ github.ref_name }}" ]]; then
            echo "❌ Erreur : Le tag Git (${{ github.ref_name }}) ne correspond pas au package.json ($VERSION)"
            exit 1
          fi
          echo "VERSION=$VERSION" >> $GITHUB_OUTPUT

      # 2. Docker Build & Push (Hub Propre)
      - name: Login to Docker Hub
        uses: docker/login-action@v3
        with:
          username: ${{ secrets.DOCKER_USERNAME }}
          password: ${{ secrets.DOCKER_PASSWORD }}

      - name: Build and Push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          # On ne crée que 2 tags : la version précise et le latest
          tags: |
            ${{ env.IMAGE_NAME }}:${{ steps.version.outputs.VERSION }}
            ${{ env.IMAGE_NAME }}:latest

      # 3. Création de la Release GitHub
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v1
        with:
          name: Klaro v${{ steps.version.outputs.VERSION }}
          generate_release_notes: true
          prerelease: false

  # JOB DEPLOIEMENT (Sur ton Cluster)
  deploy-to-cluster:
    needs: build-release-deploy
    runs-on: [self-hosted, k8s-deploy]
    if: success()
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Get Version
        id: get_version
        run: echo "VERSION=$(jq -r .version package.json)" >> $GITHUB_OUTPUT

      - name: Deploy to K3s
        env:
          TAG: ${{ steps.get_version.outputs.VERSION }}
        run: |
          echo "🚀 Déploiement de la version $TAG..."
          
          # Mise à jour de l'image dans le déploiement K8s
          kubectl set image deployment/klaro klaro=${{ env.IMAGE_NAME }}:$TAG -n apps
          
          # Vérification
          kubectl rollout status deployment/klaro -n apps
          echo "✅ Production mise à jour en v$TAG"
```

## .gitignore

```text
# Binaires et Builds
dist/
bin/
main
backend/main
backend/tmp/

# Dépendances
node_modules/
.pnpm-store/

# IDE & OS
.vscode/
.idea/
.DS_Store

# Base de données (IMPORTANT : ne jamais commit la DB de prod/dev)
*.db
*.db-journal
*.sqlite

# Environnement
.env

# sanitaize
san_*


```

## Dockerfile

```text
# ==============================================================================
# STAGE 1: Builder Frontend (Node.js)
# Objectif : Compiler le JS/CSS et générer le dossier /dist
# ==============================================================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app

# Installation de pnpm via corepack (plus propre que npm i -g)
RUN corepack enable && corepack prepare pnpm@latest --activate

# On copie uniquement les fichiers de dépendances pour profiter du cache Docker
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json ./frontend/

# Installation des dépendances
RUN pnpm install --frozen-lockfile --filter frontend

# Copie du code source et build
COPY frontend ./frontend
RUN pnpm --filter frontend build

# ==============================================================================
# STAGE 2: Builder Backend (Go)
# Objectif : Compiler un binaire statique autonome
# ==============================================================================
FROM golang:1.25-alpine AS backend-builder

WORKDIR /src

# Installation des certificats CA (nécessaire si l'app fait des requêtes HTTPS sortantes)
# et tzdata pour la gestion des timezones
RUN apk update && apk add --no-cache git ca-certificates tzdata && update-ca-certificates

# Gestion des dépendances (Cache warming)
COPY backend/go.mod backend/go.sum ./
RUN go mod download

# Copie du code source Go
COPY backend/ .

# Compilation optimisée :
# - CGO_ENABLED=0 : Pour créer un binaire statique pur (sans lien vers libc)
# - -ldflags="-w -s" : Retire les infos de debug (dwarf) pour réduire la taille (~20-30%)
# - -o /app/server : Sortie du binaire
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-w -s" -o /app/server ./cmd/server
# Création d'un utilisateur non-root pour la sécurité (uid 10001)
# On ne veut JAMAIS tourner en root dans le conteneur final
RUN echo "appuser:x:10001:10001:App User:/:" > /etc_passwd

# ==============================================================================
# STAGE 3: Final Image (Scratch)
# Objectif : L'image la plus petite et sécurisée possible (pas de shell, pas d'OS)
# ==============================================================================
FROM scratch

# Import des fichiers essentiels depuis les builders
COPY --from=backend-builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=backend-builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=backend-builder /etc_passwd /etc/passwd

# Copie du binaire Go
COPY --from=backend-builder /app/server /server

# Copie des assets statiques (Frontend compilé)
# Le serveur Go devra être configuré pour servir ce dossier
COPY --from=frontend-builder /app/frontend/dist /static

# On bascule sur l'utilisateur non-privilégié
USER appuser

# Exposition du port
EXPOSE 8080

# Démarrage
ENTRYPOINT ["/server"]
```

## Makefile

```text
# ==============================================================================
# KLARO - Project Makefile
# Orchestration: User
# Implementation: Gemini
# ==============================================================================

# Variables de projet
PROJECT_NAME := klaro
BACKEND_DIR := backend
FRONTEND_DIR := frontend

# Détection de l'OS pour les commandes spécifiques (optionnel mais propre)
GO := go
PNPM := pnpm

.PHONY: all init dev build clean docker-build help

# Par défaut, on affiche l'aide
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  init        Initialise la structure (Go module, Vue app, Pnpm workspace)"
	@echo "  dev         Lance le serveur Go (avec Air) et Vite en parallèle"
	@echo "  build       Compile le binaire Go et build le Frontend"
	@echo "  docker      Construit l'image Docker optimisée"
	@echo "  clean       Nettoie les artefacts de build"

# ==============================================================================
# 1. INITIALISATION
# ==============================================================================
init:
	@echo "🚀 Initialisation de Klaro..."
	
	# 1. Création des dossiers
	mkdir -p $(BACKEND_DIR)
	
	# 2. Setup Backend (Go)
	@echo "⚙️  Setup Backend (Go)..."
	# On ignore l'erreur si le mod existe déjà (|| true)
	cd $(BACKEND_DIR) && $(GO) mod init github.com/sicDANGBE/$(PROJECT_NAME) || true
	cd $(BACKEND_DIR) && $(GO) get -u github.com/go-chi/chi/v5 gorm.io/gorm gorm.io/driver/sqlite
	@if ! command -v air > /dev/null; then \
		echo "📦 Installation de Air (Live Reload)..."; \
		$(GO) install github.com/air-verse/air@latest; \
	fi

	# 3. Setup Frontend (Vue + Vite + Tailwind)
	@echo "🎨 Setup Frontend (Vue.js)..."
	# Si le dossier existe déjà, create vite va échouer, on check avant
	@if [ ! -d "$(FRONTEND_DIR)/src" ]; then \
		$(PNPM) create vite $(FRONTEND_DIR) --template vue-ts; \
	fi
	
	# 4. Setup Workspace & Deps
	@echo "🔗 Setup Workspace..."
	echo "packages:\n  - 'frontend'" > pnpm-workspace.yaml
	
	# Installation propre avec pnpm
	cd $(FRONTEND_DIR) && $(PNPM) install
	cd $(FRONTEND_DIR) && $(PNPM) install -D tailwindcss postcss autoprefixer
	
	# CORRECTION ICI: On utilise pnpm pour executer le binaire local
	cd $(FRONTEND_DIR) && $(PNPM) dlx tailwindcss init -p

	@echo "✅ Initialisation terminée ! Lance 'make dev' pour démarrer."

# ==============================================================================
# 2. DEVELOPPEMENT
# ==============================================================================
dev:
	@echo "🔥 Lancement de l'environnement de dev..."
	# On utilise make -j2 pour lancer les deux processus en parallèle
	# Le backend écoute sur le port 8080, le front sur 5173
	make -j2 dev-back dev-front

dev-back:
	@echo "🐘 Backend (Go + Air)..."
	cd $(BACKEND_DIR) && $$(go env GOPATH)/bin/air

dev-front:
	@echo "✨ Frontend (Vite)..."
	cd $(FRONTEND_DIR) && $(PNPM) dev

# ==============================================================================
# 3. BUILD & DOCKER
# ==============================================================================
docker:
	@echo "🐳 Construction de l'image Docker sécurisée..."
	docker build -t $(PROJECT_NAME):latest .
```

## backend/.air.toml

```toml
# backend/.air.toml

root = "."
tmp_dir = "tmp"

[build]
  # C'est ICI la clé : on lui dit de builder le dossier cmd/server
  cmd = "go build -o ./tmp/main ./cmd/server"
  
  # Où se trouve le binaire généré
  bin = "./tmp/main"

  # Pour éviter de relancer le build si on touche aux tests ou aux assets
  exclude_dir = ["assets", "tmp", "vendor", "testdata"]
  include_ext = ["go", "tpl", "tmpl", "html"]
  
  # Délai avant rebuild (évite les glitchs si tu saves vite)
  delay = 1000

[log]
  time = true

[color]
  main = "magenta"
  watcher = "cyan"
  build = "yellow"
  runner = "green"
```

## backend/api/handlers.go

```go
package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/store"
	"gorm.io/gorm"
)

// Handler détient la connexion DB pour l'injecter dans les requêtes
type Handler struct {
	DB *gorm.DB
}

// NewHandler est le constructeur de notre couche API
func NewHandler(db *gorm.DB) *Handler {
	return &Handler{DB: db}
}

// =============================================================================
// HANDLERS HTTP (CRUD)
// =============================================================================

// GetItems récupère les tâches.
// Paramètres query optionnels : ?start=2025-01-01&end=2025-01-31 (Pour le calendrier)
// Si pas de dates : renvoie tout (ou filtrer pour le backlog plus tard)
func (h *Handler) GetItems(w http.ResponseWriter, r *http.Request) {
	var items []store.Item

	// Initialisation de la requête
	query := h.DB.Preload("SubTasks").Order("date ASC") // Preload charge les sous-tâches

	// Filtrage par date si demandé (Vue Calendrier)
	start := r.URL.Query().Get("start")
	end := r.URL.Query().Get("end")

	if start != "" && end != "" {
		// On cherche les items dont la date est comprise dans l'intervalle
		query = query.Where("date BETWEEN ? AND ?", start, end)
	}

	// TODO: Pour le backlog (droite), on voudra peut-être : query.Where("date IS NULL")

	if result := query.Find(&items); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, items)
}

// CreateItem crée une nouvelle entrée (Event, Envie, etc.)
func (h *Handler) CreateItem(w http.ResponseWriter, r *http.Request) {
	var item store.Item

	// Décodage du JSON entrant
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// Sauvegarde en DB
	if result := h.DB.Create(&item); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusCreated, item)
}

// ToggleSubTask change l'état d'une sous-tâche (Check/Uncheck)
func (h *Handler) ToggleSubTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Requête SQL optimisée : On inverse juste le booléen
	// UPDATE sub_tasks SET is_done = NOT is_done WHERE id = ?
	if err := h.DB.Model(&store.SubTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

// DeleteItem supprime un item (Soft Delete par défaut avec GORM)
func (h *Handler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Conversion string -> uint
	uID, _ := strconv.ParseUint(id, 10, 32)

	// Delete
	h.DB.Delete(&store.Item{}, uID)

	w.WriteHeader(http.StatusNoContent)
}

// UpdateItem met à jour un item (ex: Drag & Drop calendrier)
func (h *Handler) UpdateItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// 1. Check existence
	var item store.Item
	if err := h.DB.First(&item, id).Error; err != nil {
		http.Error(w, "Item not found", http.StatusNotFound)
		return
	}

	// 2. Decode payload
	var payload store.Item
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 3. Update (Gorm Updates ignore les champs zero-value, parfait pour le PATCH partiel)
	// Attention: Si on veut remettre une date à NULL (retour inbox), il faudra une logique spécifique.
	// Pour l'instant on gère le mouvement vers le calendrier.
	if err := h.DB.Model(&item).Updates(payload).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, item)
}

// =============================================================================
// UTILITAIRES
// =============================================================================

// respondJSON formate la réponse en JSON standard
func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

```

## backend/cmd/server/main.go

```go
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/sicDANGBE/klaro/internal/database"
	"github.com/sicDANGBE/klaro/internal/router"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "klaro.db"
	}

	// 1. Database
	db := database.Init(dbPath)

	// 2. Router
	r := router.Setup(db)

	// 3. Start
	log.Printf("🚀 Server running on :%s", port)
	if err := http.ListenAndServe(":"+port, r); err != nil {
		log.Fatalf("Crash: %v", err)
	}
}

```

## backend/go.mod

```text
module github.com/sicDANGBE/klaro

go 1.25.1

require (
	github.com/glebarez/sqlite v1.11.0
	github.com/go-chi/chi/v5 v5.2.3
	github.com/go-chi/cors v1.2.2
	gorm.io/gorm v1.31.1
)

require (
	github.com/dustin/go-humanize v1.0.1 // indirect
	github.com/glebarez/go-sqlite v1.21.2 // indirect
	github.com/google/uuid v1.3.0 // indirect
	github.com/jinzhu/inflection v1.0.0 // indirect
	github.com/jinzhu/now v1.1.5 // indirect
	github.com/mattn/go-isatty v0.0.17 // indirect
	github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec // indirect
	golang.org/x/sys v0.7.0 // indirect
	golang.org/x/text v0.32.0 // indirect
	modernc.org/libc v1.22.5 // indirect
	modernc.org/mathutil v1.5.0 // indirect
	modernc.org/memory v1.5.0 // indirect
	modernc.org/sqlite v1.23.1 // indirect
)

```

## backend/go.sum

```text
github.com/dustin/go-humanize v1.0.1 h1:GzkhY7T5VNhEkwH0PVJgjz+fX1rhBrR7pRT3mDkpeCY=
github.com/dustin/go-humanize v1.0.1/go.mod h1:Mu1zIs6XwVuF/gI1OepvI0qD18qycQx+mFykh5fBlto=
github.com/glebarez/go-sqlite v1.21.2 h1:3a6LFC4sKahUunAmynQKLZceZCOzUthkRkEAl9gAXWo=
github.com/glebarez/go-sqlite v1.21.2/go.mod h1:sfxdZyhQjTM2Wry3gVYWaW072Ri1WMdWJi0k6+3382k=
github.com/glebarez/sqlite v1.11.0 h1:wSG0irqzP6VurnMEpFGer5Li19RpIRi2qvQz++w0GMw=
github.com/glebarez/sqlite v1.11.0/go.mod h1:h8/o8j5wiAsqSPoWELDUdJXhjAhsVliSn7bWZjOhrgQ=
github.com/go-chi/chi/v5 v5.2.3 h1:WQIt9uxdsAbgIYgid+BpYc+liqQZGMHRaUwp0JUcvdE=
github.com/go-chi/chi/v5 v5.2.3/go.mod h1:L2yAIGWB3H+phAw1NxKwWM+7eUH/lU8pOMm5hHcoops=
github.com/go-chi/cors v1.2.2 h1:Jmey33TE+b+rB7fT8MUy1u0I4L+NARQlK6LhzKPSyQE=
github.com/go-chi/cors v1.2.2/go.mod h1:sSbTewc+6wYHBBCW7ytsFSn836hqM7JxpglAy2Vzc58=
github.com/google/pprof v0.0.0-20221118152302-e6195bd50e26 h1:Xim43kblpZXfIBQsbuBVKCudVG457BR2GZFIz3uw3hQ=
github.com/google/pprof v0.0.0-20221118152302-e6195bd50e26/go.mod h1:dDKJzRmX4S37WGHujM7tX//fmj1uioxKzKxz3lo4HJo=
github.com/google/uuid v1.3.0 h1:t6JiXgmwXMjEs8VusXIJk2BXHsn+wx8BZdTaoZ5fu7I=
github.com/google/uuid v1.3.0/go.mod h1:TIyPZe4MgqvfeYDBFedMoGGpEw/LqOeaOT+nhxU+yHo=
github.com/jinzhu/inflection v1.0.0 h1:K317FqzuhWc8YvSVlFMCCUb36O/S9MCKRDI7QkRKD/E=
github.com/jinzhu/inflection v1.0.0/go.mod h1:h+uFLlag+Qp1Va5pdKtLDYj+kHp5pxUVkryuEj+Srlc=
github.com/jinzhu/now v1.1.5 h1:/o9tlHleP7gOFmsnYNz3RGnqzefHA47wQpKrrdTIwXQ=
github.com/jinzhu/now v1.1.5/go.mod h1:d3SSVoowX0Lcu0IBviAWJpolVfI5UJVZZ7cO71lE/z8=
github.com/mattn/go-isatty v0.0.17 h1:BTarxUcIeDqL27Mc+vyvdWYSL28zpIhv3RoTdsLMPng=
github.com/mattn/go-isatty v0.0.17/go.mod h1:kYGgaQfpe5nmfYZH+SKPsOc2e4SrIfOl2e/yFXSvRLM=
github.com/remyoudompheng/bigfft v0.0.0-20200410134404-eec4a21b6bb0/go.mod h1:qqbHyh8v60DhA7CoWK5oRCqLrMHRGoxYCSS9EjAz6Eo=
github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec h1:W09IVJc94icq4NjY3clb7Lk8O1qJ8BdBEF8z0ibU0rE=
github.com/remyoudompheng/bigfft v0.0.0-20230129092748-24d4a6f8daec/go.mod h1:qqbHyh8v60DhA7CoWK5oRCqLrMHRGoxYCSS9EjAz6Eo=
golang.org/x/sys v0.0.0-20220811171246-fbc7d0a398ab/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
golang.org/x/sys v0.7.0 h1:3jlCCIQZPdOYu1h8BkNvLz8Kgwtae2cagcG/VamtZRU=
golang.org/x/sys v0.7.0/go.mod h1:oPkhp1MJrh7nUepCBck5+mAzfO9JrbApNNgaTdGDITg=
golang.org/x/text v0.32.0 h1:ZD01bjUt1FQ9WJ0ClOL5vxgxOI/sVCNgX1YtKwcY0mU=
golang.org/x/text v0.32.0/go.mod h1:o/rUWzghvpD5TXrTIBuJU77MTaN0ljMWE47kxGJQ7jY=
gorm.io/gorm v1.31.1 h1:7CA8FTFz/gRfgqgpeKIBcervUn3xSyPUmr6B2WXJ7kg=
gorm.io/gorm v1.31.1/go.mod h1:XyQVbO2k6YkOis7C2437jSit3SsDK72s7n7rsSHd+Gs=
modernc.org/libc v1.22.5 h1:91BNch/e5B0uPbJFgqbxXuOnxBQjlS//icfQEGmvyjE=
modernc.org/libc v1.22.5/go.mod h1:jj+Z7dTNX8fBScMVNRAYZ/jF91K8fdT2hYMThc3YjBY=
modernc.org/mathutil v1.5.0 h1:rV0Ko/6SfM+8G+yKiyI830l3Wuz1zRutdslNoQ0kfiQ=
modernc.org/mathutil v1.5.0/go.mod h1:mZW8CKdRPY1v87qxC/wUdX5O1qDzXMP5TH3wjfpga6E=
modernc.org/memory v1.5.0 h1:N+/8c5rE6EqugZwHii4IFsaJ7MUhoWX07J5tC/iI5Ds=
modernc.org/memory v1.5.0/go.mod h1:PkUhL0Mugw21sHPeskwZW4D6VscE/GQJOnIpCnW6pSU=
modernc.org/sqlite v1.23.1 h1:nrSBg4aRQQwq59JpvGEQ15tNxoO5pX/kUjcRNwSAGQM=
modernc.org/sqlite v1.23.1/go.mod h1:OrDj17Mggn6MhE+iPbBNf7RGKODDE9NFT0f3EwDzJqk=

```

## backend/internal/database/db.go

```go
package database

import (
	"log"
	"os"
	"path/filepath"

	"github.com/glebarez/sqlite"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func Init(dbPath string) *gorm.DB {
	// Création du dossier si inexistant
	dir := filepath.Dir(dbPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		_ = os.MkdirAll(dir, 0755)
	}

	// Connexion
	db, err := gorm.Open(sqlite.Open(dbPath+"?_pragma=busy_timeout(5000)"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatal("❌ DB Connection failed:", err)
	}

	// Migration de TOUS les modèles
	err = db.AutoMigrate(
		&models.Item{},
		&models.SubTask{},
		&models.Epic{},
		&models.EpicTask{},
	)
	if err != nil {
		log.Fatal("❌ DB Migration failed:", err)
	}

	log.Println("✅ Database initialized & migrated.")
	return db
}

```

## backend/internal/handlers/epic_handler.go

```go
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
)

type EpicHandler struct {
	DB *gorm.DB
}

func NewEpicHandler(db *gorm.DB) *EpicHandler {
	return &EpicHandler{DB: db}
}

// GET /api/epics
func (h *EpicHandler) GetEpics(w http.ResponseWriter, r *http.Request) {
	var epics []models.Epic
	// On trie par date de début
	if result := h.DB.Preload("Tasks").Order("start_date ASC").Find(&epics); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, epics)
}

// POST /api/epics
func (h *EpicHandler) CreateEpic(w http.ResponseWriter, r *http.Request) {
	var epic models.Epic
	if err := json.NewDecoder(r.Body).Decode(&epic); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	// Validation
	if epic.StartDate.IsZero() || epic.EndDate.IsZero() {
		http.Error(w, "Start and End dates are required for an Epic", http.StatusBadRequest)
		return
	}

	if result := h.DB.Create(&epic); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusCreated, epic)
}

// PATCH /api/tasks/{id}/toggle
func (h *EpicHandler) ToggleEpicTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// On inverse le booléen is_done pour une EpicTask
	if err := h.DB.Model(&models.EpicTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

// POST /api/epics/{id}/tasks
func (h *EpicHandler) AddTask(w http.ResponseWriter, r *http.Request) {
	epicID := chi.URLParam(r, "id")
	uid, _ := strconv.ParseUint(epicID, 10, 32)

	var task models.EpicTask
	if err := json.NewDecoder(r.Body).Decode(&task); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	task.EpicID = uint(uid)

	if result := h.DB.Create(&task); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusCreated, task)
}

// Helper partagé
func respondJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

```

## backend/internal/handlers/item_handler.go

```go
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/sicDANGBE/klaro/internal/models"
	"gorm.io/gorm"
)

type ItemHandler struct {
	DB *gorm.DB
}

func NewItemHandler(db *gorm.DB) *ItemHandler {
	return &ItemHandler{DB: db}
}

// GET /api/items
func (h *ItemHandler) GetItems(w http.ResponseWriter, r *http.Request) {
	var items []models.Item
	if result := h.DB.Preload("SubTasks").Order("date ASC").Find(&items); result.Error != nil {
		http.Error(w, result.Error.Error(), http.StatusInternalServerError)
		return
	}
	respondJSON(w, http.StatusOK, items)
}

// POST /api/items
func (h *ItemHandler) CreateItem(w http.ResponseWriter, r *http.Request) {
	var item models.Item
	if err := json.NewDecoder(r.Body).Decode(&item); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}
	h.DB.Create(&item)
	respondJSON(w, http.StatusCreated, item)
}

// PUT /api/items/{id} (Nouveau)
func (h *ItemHandler) UpdateItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var item models.Item

	// 1. On vérifie si l'item existe
	if err := h.DB.First(&item, id).Error; err != nil {
		http.Error(w, "Item not found", http.StatusNotFound)
		return
	}

	// 2. On décode les nouvelles données
	var input models.Item
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	// 3. Mise à jour (Updates ignore les champs zero-value comme "", 0, false)
	// Si tu veux pouvoir remettre à vide, utilise map[string]interface{} ou Save()
	h.DB.Model(&item).Updates(input)

	respondJSON(w, http.StatusOK, item)
}

// DELETE /api/items/{id} (Nouveau)
func (h *ItemHandler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	// Delete avec GORM (Soft delete si gorm.Model est utilisé, sinon Hard delete)
	if err := h.DB.Delete(&models.Item{}, id).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// PATCH /api/subtasks/{id}/toggle
func (h *ItemHandler) ToggleSubTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")

	if err := h.DB.Model(&models.SubTask{}).Where("id = ?", id).
		Update("is_done", gorm.Expr("NOT is_done")).Error; err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "toggled"})
}

```

## backend/internal/models/epic.go

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

// Epic : Une mission sur la durée (ex: "Nettoyage Printemps")
type Epic struct {
	gorm.Model
	Title       string `json:"title"`
	Description string `json:"description"`
	Priority    string `json:"priority"` // On garde la priorité ici aussi

	// Gestion du temps : Début et Fin explicites
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`

	// Liste de tâches liées à l'épopée
	Tasks []EpicTask `json:"tasks" gorm:"foreignKey:EpicID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`
}

// EpicTask : Une tâche spécifique à une épopée
type EpicTask struct {
	gorm.Model
	EpicID uint   `json:"epic_id"`
	Title  string `json:"title"`
	IsDone bool   `json:"is_done" gorm:"default:false"`
}

```

## backend/internal/models/item.go

```go
package models

import (
	"time"

	"gorm.io/gorm"
)

type Item struct {
	gorm.Model
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Type        string     `json:"type"`
	Status      string     `json:"status" gorm:"default:'TODO'"`
	Date        *time.Time `json:"date"`
	IsRecurring bool       `json:"is_recurring"`
	SubTasks    []SubTask  `json:"sub_tasks" gorm:"constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`

	// Nouveaux champs V1
	Priority    string     `json:"priority"`     // LOW, MEDIUM, HIGH
	PlannedEnd  *time.Time `json:"planned_end"`  // Pour les durées
	ActualStart *time.Time `json:"actual_start"` // Quand j'ai cliqué sur "Doing"
	ActualEnd   *time.Time `json:"actual_end"`   // Quand j'ai cliqué sur "Done"

	// Pour le Drag & Drop (Ordre dans l'inbox)
	SortOrder int `json:"sort_order"`
}

type SubTask struct {
	gorm.Model
	ItemID  uint   `json:"item_id"`
	Content string `json:"content"`
	IsDone  bool   `json:"is_done"`
}

```

## backend/internal/router/router.go

```go
package router

import (
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"
	"github.com/sicDANGBE/klaro/internal/handlers"
	"gorm.io/gorm"
)

func Setup(db *gorm.DB) *chi.Mux {
	r := chi.NewRouter()

	// Middlewares
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{"*"},
		AllowedMethods:   []string{"GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"},
		AllowedHeaders:   []string{"Accept", "Authorization", "Content-Type"},
		AllowCredentials: true,
	}))

	// Initialisation des Handlers
	itemH := handlers.NewItemHandler(db)
	epicH := handlers.NewEpicHandler(db)

	// --- ROUTES API ---
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte("OK"))
		})

		// Items
		r.Get("/items", itemH.GetItems)
		r.Post("/items", itemH.CreateItem)
		r.Put("/items/{id}", itemH.UpdateItem)
		r.Delete("/items/{id}", itemH.DeleteItem)
		r.Patch("/subtasks/{id}/toggle", itemH.ToggleSubTask)

		// Epics
		r.Get("/epics", epicH.GetEpics)
		r.Post("/epics", epicH.CreateEpic)
		r.Post("/epics/{id}/tasks", epicH.AddTask)
		r.Patch("/tasks/{id}/toggle", epicH.ToggleEpicTask)
	})

	// --- SERVITUDE FICHIERS STATIQUES (FRONTEND) ---
	// Cette route capture tout ce qui n'est pas /api
	r.Get("/*", func(w http.ResponseWriter, r *http.Request) {
		// Dans l'image Docker, le front est copié dans /static
		staticDir := "/static"

		// Si on est en local (pas dans Docker), fallback optionnel (facultatif)
		if _, err := os.Stat(staticDir); os.IsNotExist(err) {
			// En dev local, c'est Vite qui gère, donc on renvoie juste un msg
			w.Write([]byte("Frontend files not found (running in dev mode?)"))
			return
		}

		// Gestion SPA (Single Page App) :
		// Si le fichier demandé n'existe pas (ex: /planner, /dashboard),
		// on renvoie index.html pour que Vue Router gère la route.
		path := filepath.Join(staticDir, r.URL.Path)
		_, err := os.Stat(path)

		if os.IsNotExist(err) || r.URL.Path == "/" {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}

		// Sinon on sert le fichier (CSS, JS, Logo...)
		http.FileServer(http.Dir(staticDir)).ServeHTTP(w, r)
	})

	return r
}

```

## backend/klaro.db

> Fichier binaire non inclus (40960 octets)

## backend/store/schema.go

```go
package store

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/glebarez/sqlite" // Driver Pure Go (Important !)
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// =============================================================================
// DEFINITION DES TYPES (ENUMS)
// =============================================================================
const (
	TypeEvent      = "EVENT"
	TypeEnvie      = "ENVIE"
	TypeResolution = "RESOLUTION"
	TypeObligation = "OBLIGATION"

	StatusTodo  = "TODO"
	StatusDoing = "DOING"
	StatusDone  = "DONE"
)

// =============================================================================
// MODELES DE DONNEES (STRUCTS)
// =============================================================================

type Item struct {
	gorm.Model
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Type        string     `json:"type"`
	Status      string     `json:"status" gorm:"default:'TODO'"`
	Date        *time.Time `json:"date"`
	IsRecurring bool       `json:"is_recurring"`
	SubTasks    []SubTask  `json:"sub_tasks" gorm:"constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`

	// Nouveaux champs V1
	Priority    string     `json:"priority"`     // LOW, MEDIUM, HIGH
	PlannedEnd  *time.Time `json:"planned_end"`  // Pour les durées
	ActualStart *time.Time `json:"actual_start"` // Quand j'ai cliqué sur "Doing"
	ActualEnd   *time.Time `json:"actual_end"`   // Quand j'ai cliqué sur "Done"

	// Pour le Drag & Drop (Ordre dans l'inbox)
	SortOrder int `json:"sort_order"`
}

type SubTask struct {
	gorm.Model
	ItemID  uint   `json:"item_id"`
	Content string `json:"content"`
	IsDone  bool   `json:"is_done"`
}

// =============================================================================
// LOGIQUE BASE DE DONNEES
// =============================================================================

func InitDB(dbPath string) *gorm.DB {
	// 1. SECURITE : Création automatique du dossier parent
	// Si dbPath est "/data/klaro.db", on s'assure que "/data" existe.
	dir := filepath.Dir(dbPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		// On crée le dossier avec les permissions 755 (rwxr-xr-x)
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("❌ Erreur critique: Impossible de créer le dossier DB '%s': %v", dir, err)
		}
	}

	// 2. Connexion GORM
	// On ajoute un paramètre pragmatique pour éviter certains verrous SQLite (_busy_timeout)
	db, err := gorm.Open(sqlite.Open(dbPath+"?_pragma=busy_timeout(5000)"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatal("❌ Echec connexion DB:", err)
	}

	// 3. Migration
	err = db.AutoMigrate(&Item{}, &SubTask{})
	if err != nil {
		log.Fatal("❌ Echec migration DB:", err)
	}

	log.Printf("✅ Base de données prête : %s", dbPath)
	return db
}

```

## backend/tmp/main

> Fichier binaire non inclus (20084812 octets)

## documentation/RELEASE_PROCESS.md

````markdown
# 📘 RELEASE_PROCESS.md

# 🚀 Canevas de Déploiement & Release — Klaro

Ce document décrit le cycle de vie de l’application.

**Philosophie :** Docker Hub reste propre. **Seules les versions taguées (releases)** génèrent une image Docker et un déploiement.

---

## 1. 🏗️ Architecture CI/CD

Le pipeline est divisé pour garantir la qualité avant la production.

| Étape              | Trigger                 | Exécuté par              | Action                                                                  |
| ------------------ | ----------------------- | ------------------------ | ----------------------------------------------------------------------- |
| 1. CI (Quality)    | Push `main` / PR        | GitHub Runners           | Linter, tests unitaires, build check. **Aucune image n’est poussée.**   |
| 2. Build & Release | **Tag `v*` uniquement** | GitHub Runners           | Construit l’image, **push** sur Docker Hub, crée la **Release GitHub**. |
| 3. Deploy          | Succès du Build         | Self-Hosted Runner (K3s) | Le cluster tire la nouvelle image taguée et met à jour les pods.        |

---

## 2. 🛡️ Discipline de Branche

⚠️ **Note importante :** le plan GitHub actuel ne permet pas le blocage technique des pushs.
Nous appliquons donc une protection par discipline.

* Interdiction de push directement sur `main` sans avoir testé localement (`make dev`).
* La branche `main` doit toujours être dans un état stable (**deployable**).
* Toute nouvelle fonctionnalité devrait idéalement être développée dans une branche `feat/ma-feature`, puis mergée dans `main`.

---

## 3. 🛠️ Flux de Développement (Features)

Pour toute modification (**hors hotfix critique**), on passe par une branche dédiée.

### 3.1 Création de la branche

```bash
# Partir de main à jour
git checkout main
git pull

# Créer la branche (Convention: feat/..., fix/..., chore/...)
git checkout -b feat/ma-nouvelle-feature
```

### 3.2 Développement & Push

```bash
# ... Coding ...
git add .
git commit -m "feat: Description de la feature"

# Premier push (configure le lien avec l'origine)
git push -u origin feat/ma-nouvelle-feature
```

### 3.3 Pull Request & Merge (via GitHub CLI)

```bash
# Créer la Pull Request vers main
# (Si c'est la première fois, utilise 'gh repo set-default saasMsDGH/klaro')
gh pr create --title "feat: Ma Feature" --body "Description des changements..."

# Une fois la CI (Quality) passée au vert :
# Merger en mode 'Squash' (1 seul commit sur main) et supprimer la branche distante
gh pr merge --squash --delete-branch
```

### 3.4 Retour sur main

```bash
git checkout main
git pull
# Ton local est maintenant à jour avec ta feature intégrée
```

---

## 4. 🔄 Procédure de Release (Mise en Prod)

C’est **l’unique méthode** pour mettre à jour la production.

**Source de vérité :** `package.json`.

### Pré-requis

* Être sur la branche `main` à jour.
* Avoir un arbre de travail propre (`git status` clean).
* Les tests locaux passent.

### Commandes à exécuter

```bash
# 1. Incrémenter la version (Patch: 0.0.1 -> 0.0.2)
# Cette commande met à jour package.json SANS créer de tag git tout de suite
npm version patch --no-git-tag-version

# 2. Vérifier la version
grep version package.json

# 3. Commiter le changement de version
git add package.json
git commit -m "chore: Bump version to $(jq -r .version package.json)"
git push origin main

# 4. Créer et pousser le tag (c’est le DÉCLENCHEUR du déploiement)
# Le tag DOIT correspondre à la version du package.json avec un 'v' devant
VERSION=$(jq -r .version package.json)
git tag v$VERSION
git push origin v$VERSION
```

---

## 5. 🔍 Vérifications Post-Déploiement

Une fois le workflow **« Build & Release (Tag Only) »** terminé sur GitHub.

* **GitHub Releases :** la release `v0.0.x` est créée avec le changelog auto-généré.
* **Docker Hub :** le tag `spadmdck/klaro:0.0.x` est présent. *(Le tag `latest` est aussi mis à jour.)*

### Cluster K3s

```bash
# Vérifier que le déploiement utilise la nouvelle version
kubectl describe deployment klaro -n apps | grep Image

# Résultat attendu : spadmdck/klaro:0.0.x
```

---

## 6. ⚠️ Dépannage

| Symptôme                               | Cause probable                                                       | Solution                                                              |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Le pipeline ne démarre pas             | Push sans tag.                                                       | Vérifier que `git push --tags` a bien été fait.                       |
| Job Build échoue : “Tag mismatch”      | Le tag Git (`v1.0.1`) ne correspond pas au `package.json` (`1.0.0`). | Corriger `package.json`, refaire un commit, supprimer/recréer le tag. |
| Erreur SQLite “Binary was compiled...” | Problème de driver CGO.                                              | Vérifier que `go.mod` utilise `github.com/glebarez/sqlite`.           |
| Docker Push “Denied”                   | Secrets manquants.                                                   | Vérifier les secrets `DOCKER_*` dans l’Organisation GitHub.           |

---

## 7. 🔐 Gestion des Secrets & Infra

* **Organisation :** `saasMsDGH`
* **Portée des secrets :** Organisation (accessibles à tous les futurs projets SaaS)
* **Runner :** Self-Hosted dans le cluster K3s (Namespace `actions-runner-system`)

````

## frontend/.gitignore

```text
# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

```

## frontend/.vscode/extensions.json

```json
{
  "recommendations": ["Vue.volar"]
}

```

## frontend/README.md

```markdown
# Vue 3 + TypeScript + Vite

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about the recommended Project Setup and IDE Support in the [Vue Docs TypeScript Guide](https://vuejs.org/guide/typescript/overview.html#project-setup).

```

## frontend/index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Klaro</title>
    <link href="https://fonts.googleapis.com/css2?family=Spline+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>

```

## frontend/package.json

```json
{
  "name": "frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@popperjs/core": "^2.11.8",
    "@tailwindcss/vite": "^4.1.18",
    "pinia": "^3.0.4",
    "v-calendar": "^3.1.2",
    "vue": "^3.5.24"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "@vitejs/plugin-vue": "^6.0.1",
    "@vue/tsconfig": "^0.8.1",
    "autoprefixer": "^10.4.23",
    "postcss": "^8.5.6",
    "tailwindcss": "^4.1.18",
    "typescript": "~5.9.3",
    "vite": "^7.2.4",
    "vue-tsc": "^3.1.4"
  }
}

```

## frontend/pnpm-lock.yaml

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      vue:
        specifier: ^3.5.24
        version: 3.5.25(typescript@5.9.3)
    devDependencies:
      '@types/node':
        specifier: ^24.10.1
        version: 24.10.4
      '@vitejs/plugin-vue':
        specifier: ^6.0.1
        version: 6.0.3(vite@7.3.0(@types/node@24.10.4))(vue@3.5.25(typescript@5.9.3))
      '@vue/tsconfig':
        specifier: ^0.8.1
        version: 0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      typescript:
        specifier: ~5.9.3
        version: 5.9.3
      vite:
        specifier: ^7.2.4
        version: 7.3.0(@types/node@24.10.4)
      vue-tsc:
        specifier: ^3.1.4
        version: 3.1.8(typescript@5.9.3)

packages:

  '@babel/helper-string-parser@7.27.1':
    resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
    engines: {node: '>=6.9.0'}

  '@babel/helper-validator-identifier@7.28.5':
    resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
    engines: {node: '>=6.9.0'}

  '@babel/parser@7.28.5':
    resolution: {integrity: sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  '@babel/types@7.28.5':
    resolution: {integrity: sha512-qQ5m48eI/MFLQ5PxQj4PFaprjyCTLI37ElWMmNs0K8Lk3dVeOdNpB3ks8jc7yM5CDmVC73eMVk/trk3fgmrUpA==}
    engines: {node: '>=6.9.0'}

  '@esbuild/aix-ppc64@0.27.2':
    resolution: {integrity: sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.27.2':
    resolution: {integrity: sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.27.2':
    resolution: {integrity: sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.27.2':
    resolution: {integrity: sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.27.2':
    resolution: {integrity: sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.27.2':
    resolution: {integrity: sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.27.2':
    resolution: {integrity: sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.27.2':
    resolution: {integrity: sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.27.2':
    resolution: {integrity: sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.27.2':
    resolution: {integrity: sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.27.2':
    resolution: {integrity: sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.27.2':
    resolution: {integrity: sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.27.2':
    resolution: {integrity: sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.27.2':
    resolution: {integrity: sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.27.2':
    resolution: {integrity: sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.27.2':
    resolution: {integrity: sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.27.2':
    resolution: {integrity: sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.27.2':
    resolution: {integrity: sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.27.2':
    resolution: {integrity: sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.27.2':
    resolution: {integrity: sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.27.2':
    resolution: {integrity: sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.27.2':
    resolution: {integrity: sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.27.2':
    resolution: {integrity: sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.27.2':
    resolution: {integrity: sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.27.2':
    resolution: {integrity: sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.27.2':
    resolution: {integrity: sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/sourcemap-codec@1.5.5':
    resolution: {integrity: sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==}

  '@rolldown/pluginutils@1.0.0-beta.53':
    resolution: {integrity: sha512-vENRlFU4YbrwVqNDZ7fLvy+JR1CRkyr01jhSiDpE1u6py3OMzQfztQU2jxykW3ALNxO4kSlqIDeYyD0Y9RcQeQ==}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    resolution: {integrity: sha512-iDGS/h7D8t7tvZ1t6+WPK04KD0MwzLZrG0se1hzBjSi5fyxlsiggoJHwh18PCFNn7tG43OWb6pdZ6Y+rMlmyNQ==}
    cpu: [arm]
    os: [android]

  '@rollup/rollup-android-arm64@4.53.5':
    resolution: {integrity: sha512-wrSAViWvZHBMMlWk6EJhvg8/rjxzyEhEdgfMMjREHEq11EtJ6IP6yfcCH57YAEca2Oe3FNCE9DSTgU70EIGmVw==}
    cpu: [arm64]
    os: [android]

  '@rollup/rollup-darwin-arm64@4.53.5':
    resolution: {integrity: sha512-S87zZPBmRO6u1YXQLwpveZm4JfPpAa6oHBX7/ghSiGH3rz/KDgAu1rKdGutV+WUI6tKDMbaBJomhnT30Y2t4VQ==}
    cpu: [arm64]
    os: [darwin]

  '@rollup/rollup-darwin-x64@4.53.5':
    resolution: {integrity: sha512-YTbnsAaHo6VrAczISxgpTva8EkfQus0VPEVJCEaboHtZRIb6h6j0BNxRBOwnDciFTZLDPW5r+ZBmhL/+YpTZgA==}
    cpu: [x64]
    os: [darwin]

  '@rollup/rollup-freebsd-arm64@4.53.5':
    resolution: {integrity: sha512-1T8eY2J8rKJWzaznV7zedfdhD1BqVs1iqILhmHDq/bqCUZsrMt+j8VCTHhP0vdfbHK3e1IQ7VYx3jlKqwlf+vw==}
    cpu: [arm64]
    os: [freebsd]

  '@rollup/rollup-freebsd-x64@4.53.5':
    resolution: {integrity: sha512-sHTiuXyBJApxRn+VFMaw1U+Qsz4kcNlxQ742snICYPrY+DDL8/ZbaC4DVIB7vgZmp3jiDaKA0WpBdP0aqPJoBQ==}
    cpu: [x64]
    os: [freebsd]

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    resolution: {integrity: sha512-dV3T9MyAf0w8zPVLVBptVlzaXxka6xg1f16VAQmjg+4KMSTWDvhimI/Y6mp8oHwNrmnmVl9XxJ/w/mO4uIQONA==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    resolution: {integrity: sha512-wIGYC1x/hyjP+KAu9+ewDI+fi5XSNiUi9Bvg6KGAh2TsNMA3tSEs+Sh6jJ/r4BV/bx/CyWu2ue9kDnIdRyafcQ==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    resolution: {integrity: sha512-Y+qVA0D9d0y2FRNiG9oM3Hut/DgODZbU9I8pLLPwAsU0tUKZ49cyV1tzmB/qRbSzGvY8lpgGkJuMyuhH7Ma+Vg==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    resolution: {integrity: sha512-juaC4bEgJsyFVfqhtGLz8mbopaWD+WeSOYr5E16y+1of6KQjc0BpwZLuxkClqY1i8sco+MdyoXPNiCkQou09+g==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    resolution: {integrity: sha512-rIEC0hZ17A42iXtHX+EPJVL/CakHo+tT7W0pbzdAGuWOt2jxDFh7A/lRhsNHBcqL4T36+UiAgwO8pbmn3dE8wA==}
    cpu: [loong64]
    os: [linux]

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    resolution: {integrity: sha512-T7l409NhUE552RcAOcmJHj3xyZ2h7vMWzcwQI0hvn5tqHh3oSoclf9WgTl+0QqffWFG8MEVZZP1/OBglKZx52Q==}
    cpu: [ppc64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    resolution: {integrity: sha512-7OK5/GhxbnrMcxIFoYfhV/TkknarkYC1hqUw1wU2xUN3TVRLNT5FmBv4KkheSG2xZ6IEbRAhTooTV2+R5Tk0lQ==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    resolution: {integrity: sha512-GwuDBE/PsXaTa76lO5eLJTyr2k8QkPipAyOrs4V/KJufHCZBJ495VCGJol35grx9xryk4V+2zd3Ri+3v7NPh+w==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    resolution: {integrity: sha512-IAE1Ziyr1qNfnmiQLHBURAD+eh/zH1pIeJjeShleII7Vj8kyEm2PF77o+lf3WTHDpNJcu4IXJxNO0Zluro8bOw==}
    cpu: [s390x]
    os: [linux]

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    resolution: {integrity: sha512-Pg6E+oP7GvZ4XwgRJBuSXZjcqpIW3yCBhK4BcsANvb47qMvAbCjR6E+1a/U2WXz1JJxp9/4Dno3/iSJLcm5auw==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.53.5':
    resolution: {integrity: sha512-txGtluxDKTxaMDzUduGP0wdfng24y1rygUMnmlUJ88fzCCULCLn7oE5kb2+tRB+MWq1QDZT6ObT5RrR8HFRKqg==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-openharmony-arm64@4.53.5':
    resolution: {integrity: sha512-3DFiLPnTxiOQV993fMc+KO8zXHTcIjgaInrqlG8zDp1TlhYl6WgrOHuJkJQ6M8zHEcntSJsUp1XFZSY8C1DYbg==}
    cpu: [arm64]
    os: [openharmony]

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    resolution: {integrity: sha512-nggc/wPpNTgjGg75hu+Q/3i32R00Lq1B6N1DO7MCU340MRKL3WZJMjA9U4K4gzy3dkZPXm9E1Nc81FItBVGRlA==}
    cpu: [arm64]
    os: [win32]

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    resolution: {integrity: sha512-U/54pTbdQpPLBdEzCT6NBCFAfSZMvmjr0twhnD9f4EIvlm9wy3jjQ38yQj1AGznrNO65EWQMgm/QUjuIVrYF9w==}
    cpu: [ia32]
    os: [win32]

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    resolution: {integrity: sha512-2NqKgZSuLH9SXBBV2dWNRCZmocgSOx8OJSdpRaEcRlIfX8YrKxUT6z0F1NpvDVhOsl190UFTRh2F2WDWWCYp3A==}
    cpu: [x64]
    os: [win32]

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    resolution: {integrity: sha512-JRpZUhCfhZ4keB5v0fe02gQJy05GqboPOaxvjugW04RLSYYoB/9t2lx2u/tMs/Na/1NXfY8QYjgRljRpN+MjTQ==}
    cpu: [x64]
    os: [win32]

  '@types/estree@1.0.8':
    resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}

  '@types/node@24.10.4':
    resolution: {integrity: sha512-vnDVpYPMzs4wunl27jHrfmwojOGKya0xyM3sH+UE5iv5uPS6vX7UIoh6m+vQc5LGBq52HBKPIn/zcSZVzeDEZg==}

  '@vitejs/plugin-vue@6.0.3':
    resolution: {integrity: sha512-TlGPkLFLVOY3T7fZrwdvKpjprR3s4fxRln0ORDo1VQ7HHyxJwTlrjKU3kpVWTlaAjIEuCTokmjkZnr8Tpc925w==}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0
      vue: ^3.2.25

  '@volar/language-core@2.4.26':
    resolution: {integrity: sha512-hH0SMitMxnB43OZpyF1IFPS9bgb2I3bpCh76m2WEK7BE0A0EzpYsRp0CCH2xNKshr7kacU5TQBLYn4zj7CG60A==}

  '@volar/source-map@2.4.26':
    resolution: {integrity: sha512-JJw0Tt/kSFsIRmgTQF4JSt81AUSI1aEye5Zl65EeZ8H35JHnTvFGmpDOBn5iOxd48fyGE+ZvZBp5FcgAy/1Qhw==}

  '@volar/typescript@2.4.26':
    resolution: {integrity: sha512-N87ecLD48Sp6zV9zID/5yuS1+5foj0DfuYGdQ6KHj/IbKvyKv1zNX6VCmnKYwtmHadEO6mFc2EKISiu3RDPAvA==}

  '@vue/compiler-core@3.5.25':
    resolution: {integrity: sha512-vay5/oQJdsNHmliWoZfHPoVZZRmnSWhug0BYT34njkYTPqClh3DNWLkZNJBVSjsNMrg0CCrBfoKkjZQPM/QVUw==}

  '@vue/compiler-dom@3.5.25':
    resolution: {integrity: sha512-4We0OAcMZsKgYoGlMjzYvaoErltdFI2/25wqanuTu+S4gismOTRTBPi4IASOjxWdzIwrYSjnqONfKvuqkXzE2Q==}

  '@vue/compiler-sfc@3.5.25':
    resolution: {integrity: sha512-PUgKp2rn8fFsI++lF2sO7gwO2d9Yj57Utr5yEsDf3GNaQcowCLKL7sf+LvVFvtJDXUp/03+dC6f2+LCv5aK1ag==}

  '@vue/compiler-ssr@3.5.25':
    resolution: {integrity: sha512-ritPSKLBcParnsKYi+GNtbdbrIE1mtuFEJ4U1sWeuOMlIziK5GtOL85t5RhsNy4uWIXPgk+OUdpnXiTdzn8o3A==}

  '@vue/language-core@3.1.8':
    resolution: {integrity: sha512-PfwAW7BLopqaJbneChNL6cUOTL3GL+0l8paYP5shhgY5toBNidWnMXWM+qDwL7MC9+zDtzCF2enT8r6VPu64iw==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  '@vue/reactivity@3.5.25':
    resolution: {integrity: sha512-5xfAypCQepv4Jog1U4zn8cZIcbKKFka3AgWHEFQeK65OW+Ys4XybP6z2kKgws4YB43KGpqp5D/K3go2UPPunLA==}

  '@vue/runtime-core@3.5.25':
    resolution: {integrity: sha512-Z751v203YWwYzy460bzsYQISDfPjHTl+6Zzwo/a3CsAf+0ccEjQ8c+0CdX1WsumRTHeywvyUFtW6KvNukT/smA==}

  '@vue/runtime-dom@3.5.25':
    resolution: {integrity: sha512-a4WrkYFbb19i9pjkz38zJBg8wa/rboNERq3+hRRb0dHiJh13c+6kAbgqCPfMaJ2gg4weWD3APZswASOfmKwamA==}

  '@vue/server-renderer@3.5.25':
    resolution: {integrity: sha512-UJaXR54vMG61i8XNIzTSf2Q7MOqZHpp8+x3XLGtE3+fL+nQd+k7O5+X3D/uWrnQXOdMw5VPih+Uremcw+u1woQ==}
    peerDependencies:
      vue: 3.5.25

  '@vue/shared@3.5.25':
    resolution: {integrity: sha512-AbOPdQQnAnzs58H2FrrDxYj/TJfmeS2jdfEEhgiKINy+bnOANmVizIEgq1r+C5zsbs6l1CCQxtcj71rwNQ4jWg==}

  '@vue/tsconfig@0.8.1':
    resolution: {integrity: sha512-aK7feIWPXFSUhsCP9PFqPyFOcz4ENkb8hZ2pneL6m2UjCkccvaOhC/5KCKluuBufvp2KzkbdA2W2pk20vLzu3g==}
    peerDependencies:
      typescript: 5.x
      vue: ^3.4.0
    peerDependenciesMeta:
      typescript:
        optional: true
      vue:
        optional: true

  alien-signals@3.1.1:
    resolution: {integrity: sha512-ogkIWbVrLwKtHY6oOAXaYkAxP+cTH7V5FZ5+Tm4NZFd8VDZ6uNMDrfzqctTZ42eTMCSR3ne3otpcxmqSnFfPYA==}

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  entities@4.5.0:
    resolution: {integrity: sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==}
    engines: {node: '>=0.12'}

  esbuild@0.27.2:
    resolution: {integrity: sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==}
    engines: {node: '>=18'}
    hasBin: true

  estree-walker@2.0.2:
    resolution: {integrity: sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==}

  fdir@6.5.0:
    resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
    engines: {node: '>=12.0.0'}
    peerDependencies:
      picomatch: ^3 || ^4
    peerDependenciesMeta:
      picomatch:
        optional: true

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  magic-string@0.30.21:
    resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}

  muggle-string@0.4.1:
    resolution: {integrity: sha512-VNTrAak/KhO2i8dqqnqnAHOa3cYBwXEZe9h+D5h/1ZqFSTEFHdM65lR7RoIqq3tBBYavsOXV84NoHXZ0AkPyqQ==}

  nanoid@3.3.11:
    resolution: {integrity: sha512-N8SpfPUnUp1bK+PMYW8qSWdl9U+wwNWI4QKxOYDy9JAro3WMX7p2OeVRF9v+347pnakNevPmiHhNmZ2HbFA76w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  path-browserify@1.0.1:
    resolution: {integrity: sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  picomatch@4.0.3:
    resolution: {integrity: sha512-5gTmgEY/sqK6gFXLIsQNH19lWb4ebPDLA4SdLP7dsWkIXHWlG66oPuVvXSGFPppYZz8ZDZq0dYYrbHfBCVUb1Q==}
    engines: {node: '>=12'}

  postcss@8.5.6:
    resolution: {integrity: sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==}
    engines: {node: ^10 || ^12 || >=14}

  rollup@4.53.5:
    resolution: {integrity: sha512-iTNAbFSlRpcHeeWu73ywU/8KuU/LZmNCSxp6fjQkJBD3ivUb8tpDrXhIxEzA05HlYMEwmtaUnb3RP+YNv162OQ==}
    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
    hasBin: true

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  tinyglobby@0.2.15:
    resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
    engines: {node: '>=12.0.0'}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.16.0:
    resolution: {integrity: sha512-Zz+aZWSj8LE6zoxD+xrjh4VfkIG8Ya6LvYkZqtUQGJPZjYl53ypCaUwWqo7eI0x66KBGeRo+mlBEkMSeSZ38Nw==}

  vite@7.3.0:
    resolution: {integrity: sha512-dZwN5L1VlUBewiP6H9s2+B3e3Jg96D0vzN+Ry73sOefebhYr9f94wwkMNN/9ouoU8pV1BqA1d1zGk8928cx0rg==}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true
    peerDependencies:
      '@types/node': ^20.19.0 || >=22.12.0
      jiti: '>=1.21.0'
      less: ^4.0.0
      lightningcss: ^1.21.0
      sass: ^1.70.0
      sass-embedded: ^1.70.0
      stylus: '>=0.54.8'
      sugarss: ^5.0.0
      terser: ^5.16.0
      tsx: ^4.8.1
      yaml: ^2.4.2
    peerDependenciesMeta:
      '@types/node':
        optional: true
      jiti:
        optional: true
      less:
        optional: true
      lightningcss:
        optional: true
      sass:
        optional: true
      sass-embedded:
        optional: true
      stylus:
        optional: true
      sugarss:
        optional: true
      terser:
        optional: true
      tsx:
        optional: true
      yaml:
        optional: true

  vscode-uri@3.1.0:
    resolution: {integrity: sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==}

  vue-tsc@3.1.8:
    resolution: {integrity: sha512-deKgwx6exIHeZwF601P1ktZKNF0bepaSN4jBU3AsbldPx9gylUc1JDxYppl82yxgkAgaz0Y0LCLOi+cXe9HMYA==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vue@3.5.25:
    resolution: {integrity: sha512-YLVdgv2K13WJ6n+kD5owehKtEXwdwXuj2TTyJMsO7pSeKw2bfRNZGjhB7YzrpbMYj5b5QsUebHpOqR3R3ziy/g==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

snapshots:

  '@babel/helper-string-parser@7.27.1': {}

  '@babel/helper-validator-identifier@7.28.5': {}

  '@babel/parser@7.28.5':
    dependencies:
      '@babel/types': 7.28.5

  '@babel/types@7.28.5':
    dependencies:
      '@babel/helper-string-parser': 7.27.1
      '@babel/helper-validator-identifier': 7.28.5

  '@esbuild/aix-ppc64@0.27.2':
    optional: true

  '@esbuild/android-arm64@0.27.2':
    optional: true

  '@esbuild/android-arm@0.27.2':
    optional: true

  '@esbuild/android-x64@0.27.2':
    optional: true

  '@esbuild/darwin-arm64@0.27.2':
    optional: true

  '@esbuild/darwin-x64@0.27.2':
    optional: true

  '@esbuild/freebsd-arm64@0.27.2':
    optional: true

  '@esbuild/freebsd-x64@0.27.2':
    optional: true

  '@esbuild/linux-arm64@0.27.2':
    optional: true

  '@esbuild/linux-arm@0.27.2':
    optional: true

  '@esbuild/linux-ia32@0.27.2':
    optional: true

  '@esbuild/linux-loong64@0.27.2':
    optional: true

  '@esbuild/linux-mips64el@0.27.2':
    optional: true

  '@esbuild/linux-ppc64@0.27.2':
    optional: true

  '@esbuild/linux-riscv64@0.27.2':
    optional: true

  '@esbuild/linux-s390x@0.27.2':
    optional: true

  '@esbuild/linux-x64@0.27.2':
    optional: true

  '@esbuild/netbsd-arm64@0.27.2':
    optional: true

  '@esbuild/netbsd-x64@0.27.2':
    optional: true

  '@esbuild/openbsd-arm64@0.27.2':
    optional: true

  '@esbuild/openbsd-x64@0.27.2':
    optional: true

  '@esbuild/openharmony-arm64@0.27.2':
    optional: true

  '@esbuild/sunos-x64@0.27.2':
    optional: true

  '@esbuild/win32-arm64@0.27.2':
    optional: true

  '@esbuild/win32-ia32@0.27.2':
    optional: true

  '@esbuild/win32-x64@0.27.2':
    optional: true

  '@jridgewell/sourcemap-codec@1.5.5': {}

  '@rolldown/pluginutils@1.0.0-beta.53': {}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    optional: true

  '@rollup/rollup-android-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-x64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-arm64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-x64@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-musl@4.53.5':
    optional: true

  '@rollup/rollup-openharmony-arm64@4.53.5':
    optional: true

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    optional: true

  '@types/estree@1.0.8': {}

  '@types/node@24.10.4':
    dependencies:
      undici-types: 7.16.0

  '@vitejs/plugin-vue@6.0.3(vite@7.3.0(@types/node@24.10.4))(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@rolldown/pluginutils': 1.0.0-beta.53
      vite: 7.3.0(@types/node@24.10.4)
      vue: 3.5.25(typescript@5.9.3)

  '@volar/language-core@2.4.26':
    dependencies:
      '@volar/source-map': 2.4.26

  '@volar/source-map@2.4.26': {}

  '@volar/typescript@2.4.26':
    dependencies:
      '@volar/language-core': 2.4.26
      path-browserify: 1.0.1
      vscode-uri: 3.1.0

  '@vue/compiler-core@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/shared': 3.5.25
      entities: 4.5.0
      estree-walker: 2.0.2
      source-map-js: 1.2.1

  '@vue/compiler-dom@3.5.25':
    dependencies:
      '@vue/compiler-core': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/compiler-sfc@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/compiler-core': 3.5.25
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      estree-walker: 2.0.2
      magic-string: 0.30.21
      postcss: 8.5.6
      source-map-js: 1.2.1

  '@vue/compiler-ssr@3.5.25':
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/language-core@3.1.8(typescript@5.9.3)':
    dependencies:
      '@volar/language-core': 2.4.26
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25
      alien-signals: 3.1.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.3
    optionalDependencies:
      typescript: 5.9.3

  '@vue/reactivity@3.5.25':
    dependencies:
      '@vue/shared': 3.5.25

  '@vue/runtime-core@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/runtime-dom@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/runtime-core': 3.5.25
      '@vue/shared': 3.5.25
      csstype: 3.2.3

  '@vue/server-renderer@3.5.25(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      vue: 3.5.25(typescript@5.9.3)

  '@vue/shared@3.5.25': {}

  '@vue/tsconfig@0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))':
    optionalDependencies:
      typescript: 5.9.3
      vue: 3.5.25(typescript@5.9.3)

  alien-signals@3.1.1: {}

  csstype@3.2.3: {}

  entities@4.5.0: {}

  esbuild@0.27.2:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.27.2
      '@esbuild/android-arm': 0.27.2
      '@esbuild/android-arm64': 0.27.2
      '@esbuild/android-x64': 0.27.2
      '@esbuild/darwin-arm64': 0.27.2
      '@esbuild/darwin-x64': 0.27.2
      '@esbuild/freebsd-arm64': 0.27.2
      '@esbuild/freebsd-x64': 0.27.2
      '@esbuild/linux-arm': 0.27.2
      '@esbuild/linux-arm64': 0.27.2
      '@esbuild/linux-ia32': 0.27.2
      '@esbuild/linux-loong64': 0.27.2
      '@esbuild/linux-mips64el': 0.27.2
      '@esbuild/linux-ppc64': 0.27.2
      '@esbuild/linux-riscv64': 0.27.2
      '@esbuild/linux-s390x': 0.27.2
      '@esbuild/linux-x64': 0.27.2
      '@esbuild/netbsd-arm64': 0.27.2
      '@esbuild/netbsd-x64': 0.27.2
      '@esbuild/openbsd-arm64': 0.27.2
      '@esbuild/openbsd-x64': 0.27.2
      '@esbuild/openharmony-arm64': 0.27.2
      '@esbuild/sunos-x64': 0.27.2
      '@esbuild/win32-arm64': 0.27.2
      '@esbuild/win32-ia32': 0.27.2
      '@esbuild/win32-x64': 0.27.2

  estree-walker@2.0.2: {}

  fdir@6.5.0(picomatch@4.0.3):
    optionalDependencies:
      picomatch: 4.0.3

  fsevents@2.3.3:
    optional: true

  magic-string@0.30.21:
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5

  muggle-string@0.4.1: {}

  nanoid@3.3.11: {}

  path-browserify@1.0.1: {}

  picocolors@1.1.1: {}

  picomatch@4.0.3: {}

  postcss@8.5.6:
    dependencies:
      nanoid: 3.3.11
      picocolors: 1.1.1
      source-map-js: 1.2.1

  rollup@4.53.5:
    dependencies:
      '@types/estree': 1.0.8
    optionalDependencies:
      '@rollup/rollup-android-arm-eabi': 4.53.5
      '@rollup/rollup-android-arm64': 4.53.5
      '@rollup/rollup-darwin-arm64': 4.53.5
      '@rollup/rollup-darwin-x64': 4.53.5
      '@rollup/rollup-freebsd-arm64': 4.53.5
      '@rollup/rollup-freebsd-x64': 4.53.5
      '@rollup/rollup-linux-arm-gnueabihf': 4.53.5
      '@rollup/rollup-linux-arm-musleabihf': 4.53.5
      '@rollup/rollup-linux-arm64-gnu': 4.53.5
      '@rollup/rollup-linux-arm64-musl': 4.53.5
      '@rollup/rollup-linux-loong64-gnu': 4.53.5
      '@rollup/rollup-linux-ppc64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-musl': 4.53.5
      '@rollup/rollup-linux-s390x-gnu': 4.53.5
      '@rollup/rollup-linux-x64-gnu': 4.53.5
      '@rollup/rollup-linux-x64-musl': 4.53.5
      '@rollup/rollup-openharmony-arm64': 4.53.5
      '@rollup/rollup-win32-arm64-msvc': 4.53.5
      '@rollup/rollup-win32-ia32-msvc': 4.53.5
      '@rollup/rollup-win32-x64-gnu': 4.53.5
      '@rollup/rollup-win32-x64-msvc': 4.53.5
      fsevents: 2.3.3

  source-map-js@1.2.1: {}

  tinyglobby@0.2.15:
    dependencies:
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3

  typescript@5.9.3: {}

  undici-types@7.16.0: {}

  vite@7.3.0(@types/node@24.10.4):
    dependencies:
      esbuild: 0.27.2
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3
      postcss: 8.5.6
      rollup: 4.53.5
      tinyglobby: 0.2.15
    optionalDependencies:
      '@types/node': 24.10.4
      fsevents: 2.3.3

  vscode-uri@3.1.0: {}

  vue-tsc@3.1.8(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.26
      '@vue/language-core': 3.1.8(typescript@5.9.3)
      typescript: 5.9.3

  vue@3.5.25(typescript@5.9.3):
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-sfc': 3.5.25
      '@vue/runtime-dom': 3.5.25
      '@vue/server-renderer': 3.5.25(vue@3.5.25(typescript@5.9.3))
      '@vue/shared': 3.5.25
    optionalDependencies:
      typescript: 5.9.3

```

## frontend/src/App.vue

```text
<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue';
import { useKlaroStore, type Item, type Epic } from './stores/klaro'; // Ajout type Epic
import CreateModal from './components/CreateModal.vue';
import DetailModal from './components/DetailModal.vue';
import EditModal from './components/EditModal.vue';
import DashboardView from './components/DashboardView.vue';

const store = useKlaroStore();

// 1. On initialise avec la valeur sauvegardée OU la valeur par défaut
const savedView = localStorage.getItem('currentView') as 'dashboard' | 'calendar' | null;
const currentView = ref<'dashboard' | 'calendar'>(savedView || 'dashboard');

const savedMode = localStorage.getItem('calendarMode') as 'month' | 'week' | null;
const calendarMode = ref<'month' | 'week'>(savedMode || 'month');

// 2. On surveille les changements pour sauvegarder automatiquement
watch(currentView, (newVal) => {
  localStorage.setItem('currentView', newVal);
});

watch(calendarMode, (newVal) => {
  localStorage.setItem('calendarMode', newVal);
});

const isDarkMode = ref(false);


// --- NAVIGATION & DATES ---
const currentDate = ref(new Date()); 

// Titre dynamique
const currentLabel = computed(() => {
  if (calendarMode.value === 'month') {
    return currentDate.value.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  } else {
    const start = new Date(currentDate.value);
    const day = start.getDay();
    const diff = start.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(start.setDate(diff));
    return `Semaine du ${monday.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`;
  }
});

// --- LOGIQUE VUE SEMAINE ---
const weekDays = computed(() => {
  const start = new Date(currentDate.value);
  const day = start.getDay();
  const diff = start.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(start.setDate(diff));
  
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    days.push(d);
  }
  return days;
});
const hours = Array.from({ length: 24 }, (_, i) => i);

// --- LOGIQUE VUE MOIS ---
const monthGrid = computed(() => {
  const year = currentDate.value.getFullYear();
  const month = currentDate.value.getMonth();
  const firstDayOfMonth = new Date(year, month, 1);
  const lastDayOfMonth = new Date(year, month + 1, 0);
  
  let startDay = firstDayOfMonth.getDay(); 
  if (startDay === 0) startDay = 7; 
  
  const days = [];
  const prevMonthLastDay = new Date(year, month, 0).getDate();
  
  for (let i = startDay - 1; i > 0; i--) {
    days.push({
      date: new Date(year, month - 1, prevMonthLastDay - i + 1),
      isCurrentMonth: false,
      isToday: false
    });
  }
  
  const todayStr = new Date().toDateString();
  for (let i = 1; i <= lastDayOfMonth.getDate(); i++) {
    const d = new Date(year, month, i);
    days.push({
      date: d,
      isCurrentMonth: true,
      isToday: d.toDateString() === todayStr
    });
  }
  
  const remaining = 42 - days.length;
  for (let i = 1; i <= remaining; i++) {
    days.push({
      date: new Date(year, month + 1, i),
      isCurrentMonth: false,
      isToday: false
    });
  }
  return days;
});

const navigate = (direction: number) => {
  const d = new Date(currentDate.value);
  if (calendarMode.value === 'week') {
    d.setDate(d.getDate() + (direction * 7));
  } else {
    d.setMonth(d.getMonth() + direction);
  }
  currentDate.value = d;
};

const goToToday = () => { currentDate.value = new Date(); };

// --- FILTRES ITEMS & EPICS (NOUVEAU) ---

const getItemsForSlot = (date: Date, hour?: number) => {
  const dateStr = date.toISOString().split('T')[0];
  return store.items.filter(i => {
    if (!i.date) return false;
    const d = new Date(i.date);
    const sameDay = d.toISOString().split('T')[0] === dateStr;
    if (hour !== undefined) {
      return sameDay && d.getHours() === hour;
    }
    return sameDay;
  });
};

// Fonction pour récupérer les épopées actives sur une date donnée
const getEpicsForDay = (date: Date): Epic[] => {
  const targetTime = date.getTime();
  return store.epics.filter(epic => {
    const start = new Date(epic.start_date).setHours(0,0,0,0);
    const end = new Date(epic.end_date).setHours(23,59,59,999);
    return targetTime >= start && targetTime <= end;
  });
};

const isModalOpen = ref(false);
const isDetailOpen = ref(false);
const isEditOpen = ref(false);
const selectedItem = ref<Item | null>(null);
const draggedItem = ref<Item | null>(null);

const toggleDarkMode = () => {
  isDarkMode.value = !isDarkMode.value;
  if (isDarkMode.value) {
    document.documentElement.classList.add('dark');
    localStorage.setItem('theme', 'dark');
  } else {
    document.documentElement.classList.remove('dark');
    localStorage.setItem('theme', 'light');
  }
};

onMounted(() => {
  store.fetchAll(); // Charge Items ET Epics
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    isDarkMode.value = true;
    document.documentElement.classList.add('dark');
  }
});

const onDragStart = (event: DragEvent, item: Item) => {
  if (event.dataTransfer) {
    draggedItem.value = item;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.dropEffect = 'move';
  }
};

const onDrop = async (_: DragEvent, targetDate: Date, hour?: number) => {
  if (!draggedItem.value) return;
  const d = new Date(targetDate);
  if (hour !== undefined) {
    d.setHours(hour);
    d.setMinutes(0);
  }
  await store.updateItem({
    ...draggedItem.value,
    date: d.toISOString(),
    status: 'TODO'
  });
  draggedItem.value = null;
};

const openDetail = (item: Item) => { selectedItem.value = item; isDetailOpen.value = true; };
const switchToEdit = () => { isDetailOpen.value = false; isEditOpen.value = true; };

const getTypeClass = (type: string) => {
  switch(type) {
    case 'OBLIGATION': return 'bg-tag-red-bg text-tag-red-text border border-tag-red-bg';
    case 'RESOLUTION': return 'bg-tag-purple-bg text-tag-purple-text border border-tag-purple-bg';
    case 'ENVIE': return 'bg-tag-yellow-bg text-tag-yellow-text border border-tag-yellow-bg';
    case 'EVENT': return 'bg-tag-blue-bg text-tag-blue-text border border-tag-blue-bg';
    default: return 'bg-bg-element text-text-muted';
  }
};

const weekDayNames = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
</script>

<template>
  <header class="h-16 flex-none px-6 flex items-center justify-between z-30 bg-bg-surface/80 backdrop-blur-md border-b border-border-main transition-colors">
    <div class="flex items-center gap-4">
      <div class="size-9 bg-text-main text-primary-content rounded-lg flex items-center justify-center shadow-lg transform -rotate-3 transition-transform hover:rotate-0">
        <span class="font-black text-xl text-primary">K</span>
      </div>
      <div>
        <h1 class="text-lg font-bold text-text-main leading-none">Klaro</h1>
        <span class="text-[10px] font-bold text-text-muted uppercase tracking-widest">Workspace</span>
      </div>
    </div>
    
    <div class="hidden md:flex items-center bg-bg-element rounded-full p-1 border border-border-main gap-1">
      <button 
        @click="currentView = 'dashboard'"
        class="px-6 py-1.5 rounded-full text-sm font-bold transition-all flex items-center gap-2"
        :class="currentView === 'dashboard' ? 'bg-bg-surface text-text-main shadow-sm ring-1 ring-black/5 dark:ring-white/10' : 'text-text-muted hover:text-text-main'"
      >
        <span class="material-symbols-outlined text-[18px]">dashboard</span>
        Dashboard
      </button>
      <button 
        @click="currentView = 'calendar'"
        class="px-6 py-1.5 rounded-full text-sm font-bold transition-all flex items-center gap-2"
        :class="currentView === 'calendar' ? 'bg-bg-surface text-text-main shadow-sm ring-1 ring-black/5 dark:ring-white/10' : 'text-text-muted hover:text-text-main'"
      >
        <span class="material-symbols-outlined text-[18px]">calendar_month</span>
        Planner
      </button>
    </div>

    <div class="flex items-center gap-3">
      <button @click="toggleDarkMode" class="size-9 rounded-full flex items-center justify-center text-text-muted hover:bg-bg-element hover:text-primary transition-colors">
        <span class="material-symbols-outlined text-[20px]">{{ isDarkMode ? 'light_mode' : 'dark_mode' }}</span>
      </button>
      <div class="h-6 w-px bg-border-main mx-1"></div>
      <div class="size-9 rounded-full bg-gradient-to-br from-primary to-orange-400 border-2 border-bg-surface shadow-sm cursor-pointer hover:scale-105 transition-transform"></div>
    </div>
  </header>

  <div class="flex flex-1 overflow-hidden bg-bg-app transition-colors">
    
    <main class="flex-[3] flex flex-col p-4 lg:p-6 min-w-0 relative z-0">
      <div class="flex-1 bg-bg-surface rounded-2xl shadow-card border border-border-main overflow-hidden relative flex flex-col transition-colors">
        
        <DashboardView v-if="currentView === 'dashboard'" />

        <div v-else class="h-full w-full flex flex-col">
          
          <div class="p-4 border-b border-border-main flex justify-between items-center bg-bg-surface shrink-0">
             <div class="flex items-center gap-2">
                <button @click="navigate(-1)" class="size-8 rounded-full border border-border-main flex items-center justify-center hover:bg-bg-element transition-colors">
                  <span class="material-symbols-outlined text-[18px]">chevron_left</span>
                </button>
                <button @click="navigate(1)" class="size-8 rounded-full border border-border-main flex items-center justify-center hover:bg-bg-element transition-colors">
                  <span class="material-symbols-outlined text-[18px]">chevron_right</span>
                </button>
                <button @click="goToToday" class="px-3 h-8 rounded-full border border-border-main text-xs font-bold hover:bg-bg-element transition-colors">
                  Aujourd'hui
                </button>
                <span class="ml-2 text-sm font-bold text-text-main capitalize">
                  {{ currentLabel }}
                </span>
             </div>

             <div class="flex bg-bg-element rounded-lg p-1 gap-1">
                <button 
                  @click="calendarMode = 'month'"
                  class="px-3 py-1 rounded-md text-xs font-bold transition-all"
                  :class="calendarMode === 'month' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'"
                >
                  Mois
                </button>
                <button 
                  @click="calendarMode = 'week'"
                  class="px-3 py-1 rounded-md text-xs font-bold transition-all"
                  :class="calendarMode === 'week' ? 'bg-bg-surface text-text-main shadow-sm' : 'text-text-muted hover:text-text-main'"
                >
                  Semaine
                </button>
             </div>
          </div>

          <div v-if="calendarMode === 'month'" class="flex-1 flex flex-col min-h-0">
            <div class="grid grid-cols-7 border-b border-border-main bg-bg-surface/50">
              <div v-for="day in weekDayNames" :key="day" class="py-2 text-center text-[11px] font-bold uppercase text-text-muted tracking-wider">
                {{ day }}
              </div>
            </div>
            
            <div class="flex-1 grid grid-cols-7 grid-rows-6">
              <div 
                v-for="(cell, index) in monthGrid" 
                :key="index"
                class="border-r border-b border-border-subtle p-2 relative group flex flex-col gap-1 overflow-hidden transition-colors"
                :class="[
                  !cell.isCurrentMonth ? 'bg-bg-element/30 text-text-muted/50' : 'bg-bg-surface hover:bg-bg-element/30',
                  cell.isToday ? 'bg-primary/5' : ''
                ]"
                @dragover.prevent
                @drop="onDrop($event, cell.date)"
                @click.self="isModalOpen = true"
              >
                <span 
                  class="text-xs font-bold ml-auto mb-1 size-6 flex items-center justify-center rounded-full"
                  :class="cell.isToday ? 'bg-primary text-black' : 'text-text-muted'"
                >
                  {{ cell.date.getDate() }}
                </span>

                <div class="flex flex-col gap-1 mb-1">
                    <div 
                        v-for="epic in getEpicsForDay(cell.date)" 
                        :key="epic.ID"
                        class="h-5 px-2 rounded-md bg-purple-100 dark:bg-purple-900/30 border border-purple-200 dark:border-purple-700 text-purple-700 dark:text-purple-300 text-[10px] font-bold flex items-center truncate cursor-pointer hover:brightness-110"
                    >
                        <span class="truncate">{{ epic.title }}</span>
                    </div>
                </div>

                <div class="flex flex-col gap-1 overflow-y-auto custom-scroll">
                  <div 
                    v-for="item in getItemsForSlot(cell.date)" :key="item.ID"
                    @click.stop="openDetail(item)"
                    class="px-2 py-1 rounded-md text-[10px] font-bold border truncate shadow-sm cursor-pointer hover:brightness-110 flex items-center gap-1.5"
                    :class="getTypeClass(item.type)"
                  >
                    <span class="size-1.5 rounded-full bg-current opacity-70 flex-shrink-0"></span>
                    <span class="truncate">{{ item.title }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="flex-1 flex flex-col min-h-0 bg-bg-surface">
            <div class="flex border-b border-border-main bg-bg-surface overflow-hidden ml-[100px]">
               <div v-for="h in hours" :key="h" class="flex-none w-[80px] py-2 text-center text-xs font-medium text-text-muted border-r border-border-subtle">
                 {{ h }}:00
               </div>
            </div>

            <div class="flex-1 overflow-y-auto custom-scroll overflow-x-auto">
               <div class="min-w-max">
                  <div v-for="day in weekDays" :key="day.toISOString()" class="flex border-b border-border-subtle min-h-[100px] hover:bg-bg-element/20 transition-colors group/row">
                    
                    <div class="sticky left-0 w-[100px] flex-none bg-bg-surface border-r border-border-main z-20 flex flex-col p-2 group-hover/row:bg-bg-element/20">
                      <div class="flex flex-col items-center justify-center mb-2">
                        <span class="text-xs font-bold text-text-muted uppercase">{{ day.toLocaleDateString('fr-FR', { weekday: 'short' }) }}</span>
                        <span class="text-xl font-black" :class="day.toDateString() === new Date().toDateString() ? 'text-primary' : 'text-text-main'">
                            {{ day.getDate() }}
                        </span>
                      </div>
                      
                      <div class="flex flex-col gap-1 w-full">
                        <div 
                            v-for="epic in getEpicsForDay(day)" 
                            :key="epic.ID"
                            class="w-full text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 truncate border border-purple-200 dark:border-purple-700"
                            title="Projet en cours"
                        >
                           {{ epic.title }}
                        </div>
                      </div>
                    </div>

                    <div class="flex">
                      <div 
                        v-for="h in hours" :key="h"
                        class="flex-none w-[80px] border-r border-border-subtle relative group/cell h-full"
                        @dragover.prevent
                        @drop="onDrop($event, day, h)"
                      >
                        <div class="absolute inset-1 flex flex-col gap-1 overflow-y-auto custom-scroll">
                           <div 
                              v-for="item in getItemsForSlot(day, h)" 
                              :key="item.ID"
                              @click.stop="openDetail(item)"
                              class="px-1.5 py-1 rounded text-[10px] font-bold border shadow-sm cursor-pointer hover:scale-105 transition-transform truncate"
                              :class="getTypeClass(item.type)"
                           >
                             {{ item.title }}
                           </div>
                        </div>
                        <div v-if="draggedItem" class="absolute inset-0 bg-primary/10 opacity-0 group-hover/cell:opacity-100 pointer-events-none transition-opacity"></div>
                      </div>
                    </div>

                  </div>
               </div>
            </div>
          </div>

          <button @click="isModalOpen = true" class="absolute bottom-10 right-10 size-14 bg-text-main text-primary rounded-full shadow-floating hover:scale-110 hover:rotate-90 transition-all duration-300 flex items-center justify-center z-20 cursor-pointer border-2 border-bg-surface">
              <span class="material-symbols-outlined text-[28px]">add</span>
          </button>
        </div>

      </div>
    </main>

    <aside class="flex-[1] flex flex-col p-4 lg:p-6 pl-0 w-80 min-w-[320px]">
      <div class="bg-bg-surface rounded-2xl shadow-card border border-border-main flex flex-col h-full overflow-hidden transition-colors">
        <div class="p-5 border-b border-border-main flex items-center justify-between">
          <div class="flex items-center gap-2">
            <h3 class="text-lg font-bold text-text-main">Inbox</h3>
            <span class="bg-bg-element text-text-muted text-xs font-bold px-2 py-0.5 rounded-md">{{ store.backlogItems.length }}</span>
          </div>
        </div>
        <div class="flex-1 overflow-y-auto p-4 flex flex-col gap-3 custom-scroll bg-bg-app/50">
          <div 
            v-for="item in store.backlogItems" :key="item.ID"
            draggable="true" @dragstart="onDragStart($event, item)" @click="openDetail(item)"
            class="group bg-bg-surface p-3.5 rounded-xl border border-border-main hover:border-primary/50 shadow-sm hover:shadow-md transition-all cursor-grab active:cursor-grabbing hover:-translate-x-1"
          >
            <div class="flex justify-between items-start mb-2">
              <span class="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide border" :class="getTypeClass(item.type)">{{ item.type }}</span>
            </div>
            <h4 class="text-sm font-bold text-text-main leading-snug mb-2">{{ item.title }}</h4>
          </div>
          <div v-if="store.backlogItems.length === 0" class="flex flex-col items-center justify-center py-12 text-text-muted opacity-50">
            <p class="text-sm font-medium">Inbox Zero</p>
          </div>
        </div>
        <div class="p-4 border-t border-border-main bg-bg-surface">
            <div class="w-full h-10 rounded-lg bg-bg-element border border-transparent hover:border-primary/50 flex items-center px-3 gap-2 cursor-pointer" @click="isModalOpen=true">
                <span class="material-symbols-outlined text-text-muted text-[18px]">add_circle</span>
                <span class="text-sm text-text-muted font-medium">Ajouter tâche...</span>
            </div>
        </div>
      </div>
    </aside>

    <CreateModal :isOpen="isModalOpen" @close="isModalOpen = false" />
    <DetailModal :isOpen="isDetailOpen" :item="selectedItem" @close="isDetailOpen = false" @edit="switchToEdit" />
    <EditModal :isOpen="isEditOpen" :item="selectedItem" @close="isEditOpen = false" />

  </div>
</template>
```

## frontend/src/components/CreateModal.vue

```text
<script setup lang="ts">
import { ref, reactive, watch } from 'vue';
import { useKlaroStore } from '../stores/klaro';

const props = defineProps<{ isOpen: boolean }>();
const emit = defineEmits(['close']);
const store = useKlaroStore();

// Gestion des Onglets
const activeTab = ref<'item' | 'epic'>('item');

// Formulaire Tâche (Existant)
const newItem = reactive({
  title: '',
  description: '',
  type: 'EVENT',
  date: new Date().toISOString().split('T')[0], // Par défaut aujourd'hui
  priority: 'MEDIUM'
});

// Formulaire Épopée (Nouveau)
const newEpic = reactive({
  title: '',
  description: '',
  start_date: '',
  end_date: '',
  priority: 'MEDIUM'
});

const resetForms = () => {
  // Reset Item
  newItem.title = '';
  newItem.description = '';
  newItem.type = 'EVENT';
  newItem.date = new Date().toISOString().split('T')[0];
  newItem.priority = 'MEDIUM';
  
  // Reset Epic
  newEpic.title = '';
  newEpic.description = '';
  newEpic.start_date = '';
  newEpic.end_date = '';
  newEpic.priority = 'MEDIUM';
  
  // Reset Tab
  activeTab.value = 'item';
};

const create = async () => {
  if (activeTab.value === 'item') {
    // --- Création Tâche ---
    if (!newItem.title) return;
    
    // Si type est EVENT/OBLIGATION, on garde la date, sinon (ENVIE) c'est peut-être null (Backlog)
    // Ici on simplifie : si date est remplie, on l'envoie.
    const payload: any = { ...newItem };
    if (!payload.date) delete payload.date;

    await store.createItem(payload);

  } else {
    // --- Création Épopée ---
    if (!newEpic.title || !newEpic.start_date || !newEpic.end_date) return;
    
    await store.createEpic({
        title: newEpic.title,
        description: newEpic.description,
        priority: newEpic.priority as 'LOW'|'MEDIUM'|'HIGH',
        start_date: new Date(newEpic.start_date).toISOString(),
        end_date: new Date(newEpic.end_date).toISOString()
    });
  }
  
  resetForms();
  emit('close');
};

// Reset à l'ouverture
watch(() => props.isOpen, (val) => {
  if (val) resetForms();
});
</script>

<template>
  <div v-if="isOpen" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-bg-app/80 backdrop-blur-sm transition-opacity" @click="$emit('close')"></div>

    <div class="relative bg-bg-surface w-full max-w-md rounded-2xl shadow-floating border border-border-main overflow-hidden flex flex-col max-h-[90vh]">
      
      <div class="bg-bg-element border-b border-border-main">
        <div class="flex justify-between items-center p-4 pb-2">
            <h2 class="text-lg font-bold text-text-main">Nouvelle Entrée</h2>
            <button @click="$emit('close')" class="text-text-muted hover:text-text-main transition-colors">
            <span class="material-symbols-outlined">close</span>
            </button>
        </div>

        <div class="flex px-2 gap-1">
            <button 
                @click="activeTab = 'item'"
                class="flex-1 flex items-center justify-center gap-2 pb-3 pt-2 text-sm font-bold border-b-2 transition-all"
                :class="activeTab === 'item' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-main'"
            >
                <span class="material-symbols-outlined text-[18px]">event</span>
                Tâche Rapide
            </button>
            <button 
                @click="activeTab = 'epic'"
                class="flex-1 flex items-center justify-center gap-2 pb-3 pt-2 text-sm font-bold border-b-2 transition-all"
                :class="activeTab === 'epic' ? 'border-primary text-primary' : 'border-transparent text-text-muted hover:text-text-main'"
            >
                <span class="material-symbols-outlined text-[18px]">rocket_launch</span>
                Projet / Épopée
            </button>
        </div>
      </div>

      <div class="p-6 flex flex-col gap-5 overflow-y-auto custom-scroll">
        
        <div v-if="activeTab === 'item'" class="flex flex-col gap-4">
            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Titre</label>
                <input v-model="newItem.title" type="text" placeholder="Ex: Faire les courses..." class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main placeholder:text-text-muted/50" autofocus />
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-bold text-text-muted uppercase">Type</label>
                    <select v-model="newItem.type" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main appearance-none">
                        <option value="EVENT">Événement</option>
                        <option value="OBLIGATION">Obligation</option>
                        <option value="RESOLUTION">Résolution</option>
                        <option value="ENVIE">Envie</option>
                    </select>
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-bold text-text-muted uppercase">Priorité</label>
                    <select v-model="newItem.priority" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main appearance-none">
                        <option value="LOW">Faible</option>
                        <option value="MEDIUM">Moyenne</option>
                        <option value="HIGH">Haute</option>
                    </select>
                </div>
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Date cible</label>
                <input v-model="newItem.date" type="date" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main" />
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Description</label>
                <textarea v-model="newItem.description" rows="3" placeholder="Détails..." class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main placeholder:text-text-muted/50 resize-none"></textarea>
            </div>
        </div>

        <div v-else class="flex flex-col gap-4">
            <div class="p-3 bg-primary/10 rounded-lg border border-primary/20 flex items-start gap-3">
                 <span class="material-symbols-outlined text-primary mt-0.5">info</span>
                 <p class="text-xs text-text-main leading-relaxed">
                    Une <strong>Épopée</strong> est un projet sur la durée (ex: "Nettoyage de Printemps"). Vous pourrez y ajouter des tâches spécifiques une fois créée.
                 </p>
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Nom du Projet</label>
                <input v-model="newEpic.title" type="text" placeholder="Ex: Refonte Site Web..." class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main" />
            </div>

            <div class="grid grid-cols-2 gap-4">
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-bold text-text-muted uppercase">Début <span class="text-red-500">*</span></label>
                    <input v-model="newEpic.start_date" type="date" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main" />
                </div>
                <div class="flex flex-col gap-1.5">
                    <label class="text-xs font-bold text-text-muted uppercase">Fin <span class="text-red-500">*</span></label>
                    <input v-model="newEpic.end_date" type="date" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main" />
                </div>
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Priorité Globale</label>
                <select v-model="newEpic.priority" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main appearance-none">
                    <option value="LOW">Faible</option>
                    <option value="MEDIUM">Moyenne</option>
                    <option value="HIGH">Haute</option>
                </select>
            </div>

            <div class="flex flex-col gap-1.5">
                <label class="text-xs font-bold text-text-muted uppercase">Description / Objectif</label>
                <textarea v-model="newEpic.description" rows="3" placeholder="Quel est l'objectif principal ?" class="w-full bg-bg-element border border-border-main rounded-lg px-3 py-2 text-sm font-medium focus:outline-none focus:border-primary transition-colors text-text-main resize-none"></textarea>
            </div>
        </div>

      </div>

      <div class="p-4 border-t border-border-main bg-bg-surface flex justify-end gap-3">
        <button @click="$emit('close')" class="px-4 py-2 rounded-lg text-sm font-bold text-text-muted hover:bg-bg-element transition-colors">
            Annuler
        </button>
        <button 
            @click="create" 
            class="px-6 py-2 rounded-lg text-sm font-bold text-primary-content shadow-lg shadow-primary/20 hover:shadow-xl hover:-translate-y-0.5 transition-all active:scale-95"
            :class="activeTab === 'item' ? 'bg-primary' : 'bg-gradient-to-r from-primary to-purple-500'"
        >
            {{ activeTab === 'item' ? 'Ajouter Tâche' : 'Lancer Projet' }}
        </button>
      </div>
    </div>
  </div>
</template>
```

## frontend/src/components/DashboardView.vue

```text
<script setup lang="ts">
import { useKlaroStore } from '../stores/klaro';
import { computed } from 'vue';

const store = useKlaroStore();

const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
});

// Donut Chart CSS dynamique
const donutStyle = computed(() => {
  const percent = store.completionRate;
  // On utilise la variable CSS pour la couleur de fond du donut (gris clair/foncé)
  // Astuce: getComputedStyle ne marche pas bien en setup(), on hardcode les fallbacks hex proches de nos vars
  return {
    background: `conic-gradient(#f9f506 0% ${percent}%, transparent ${percent}% 100%)`
  };
});

const getTypeClass = (type: string) => {
  switch(type) {
    case 'OBLIGATION': return 'bg-tag-red-bg text-tag-red-text';
    case 'RESOLUTION': return 'bg-tag-purple-bg text-tag-purple-text';
    case 'ENVIE': return 'bg-tag-yellow-bg text-tag-yellow-text';
    case 'EVENT': return 'bg-tag-blue-bg text-tag-blue-text';
    default: return 'bg-bg-element text-text-muted';
  }
};
</script>

<template>
  <div class="h-full flex flex-col overflow-y-auto p-6 lg:px-10 custom-scroll bg-bg-app transition-colors">
    <div class="max-w-7xl mx-auto flex flex-col gap-10 pb-12 w-full">
      
      <!-- Header -->
      <header class="flex flex-col gap-3 pt-6">
        <h1 class="text-4xl md:text-5xl font-black tracking-tight text-text-main">
          {{ greeting }}, Romeo.
        </h1>
        <div class="flex items-center gap-3">
          <span class="flex size-3 bg-primary rounded-full shadow-glow animate-pulse"></span>
          <p class="text-text-muted text-xl">
            You have <span class="font-bold text-text-main">{{ store.focusItems.length }} priorities</span> today.
          </p>
        </div>
      </header>

      <!-- Priority Cards Grid -->
      <section class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        
        <div 
          v-for="item in store.focusItems" 
          :key="item.ID"
          class="group flex flex-col bg-bg-surface rounded-2xl border border-border-main shadow-soft hover:shadow-lg hover:-translate-y-1 transition-all duration-300 overflow-hidden cursor-pointer"
        >
          <!-- Abstract Header -->
          <div class="h-32 w-full bg-bg-element relative overflow-hidden">
            <div class="absolute inset-0 opacity-10 bg-[radial-gradient(circle_at_top_right,_var(--tw-gradient-stops))] from-primary via-transparent to-transparent"></div>
            <div class="absolute top-4 left-4">
              <span class="px-2.5 py-1 rounded-md text-xs font-bold uppercase tracking-wide" :class="getTypeClass(item.type)">
                {{ item.type }}
              </span>
            </div>
          </div>

          <div class="p-6 flex flex-col gap-4 flex-1">
            <div>
              <div class="flex justify-between items-start mb-2">
                <h3 class="text-lg font-bold text-text-main leading-tight line-clamp-2 group-hover:text-primary-hover transition-colors">
                  {{ item.title }}
                </h3>
                <span v-if="item.priority === 'HIGH'" class="material-symbols-outlined text-red-500 animate-bounce" title="High Priority">priority_high</span>
              </div>
              
              <!-- Subtasks Progress -->
              <div v-if="item.sub_tasks?.length" class="flex flex-col gap-2 mt-3">
                <div class="flex items-center justify-between text-xs text-text-muted">
                  <span class="flex items-center gap-1"><span class="material-symbols-outlined text-[14px]">checklist</span> Tasks</span>
                  <span>{{ item.sub_tasks.filter(t => t.is_done).length }}/{{ item.sub_tasks.length }}</span>
                </div>
                <div class="w-full h-1.5 bg-bg-element rounded-full overflow-hidden">
                  <div class="h-full bg-primary" :style="{ width: (item.sub_tasks.filter(t => t.is_done).length / item.sub_tasks.length * 100) + '%' }"></div>
                </div>
              </div>
              <p v-else class="text-sm text-text-muted mt-2 italic">Quick task. Just do it.</p>
            </div>
            
            <div class="mt-auto pt-2">
              <button class="w-full flex items-center justify-center gap-2 rounded-lg h-9 bg-bg-element hover:bg-text-main hover:text-bg-surface text-text-main font-bold text-sm transition-all">
                <span class="material-symbols-outlined text-[18px]">play_arrow</span>
                Focus Now
              </button>
            </div>
          </div>
        </div>

        <!-- Empty State -->
        <div v-if="store.focusItems.length === 0" class="col-span-full py-16 flex flex-col items-center justify-center text-center border-2 border-dashed border-border-main rounded-2xl bg-bg-surface/50">
          <span class="material-symbols-outlined text-4xl text-text-muted mb-2 opacity-50">spa</span>
          <h3 class="text-lg font-bold text-text-main">All clear!</h3>
          <p class="text-text-muted">No urgent tasks for today.</p>
        </div>

      </section>

      <!-- Weekly Stats -->
      <section>
        <div class="bg-bg-surface rounded-2xl border border-border-main p-8 shadow-soft flex flex-col md:flex-row items-center justify-between gap-10">
          <div class="flex flex-col gap-3 max-w-lg">
            <h2 class="text-2xl font-bold text-text-main">Weekly Momentum</h2>
            <p class="text-text-muted leading-relaxed">
              Consistance is key. You're doing great.
            </p>
          </div>

          <!-- Donut -->
          <div class="relative size-40 flex-shrink-0">
            <!-- Background circle -->
            <div class="absolute inset-0 rounded-full border-[12px] border-bg-element"></div>
            <!-- Progress (Conic) -->
            <div class="absolute inset-0 rounded-full" :style="donutStyle" style="mask: radial-gradient(transparent 58%, black 60%); -webkit-mask: radial-gradient(transparent 58%, black 60%);"></div>
            
            <div class="absolute inset-0 flex items-center justify-center flex-col">
              <span class="text-3xl font-black text-text-main">{{ store.completionRate }}%</span>
              <span class="text-[10px] font-bold text-text-muted uppercase tracking-wider">Done</span>
            </div>
          </div>
        </div>
      </section>

    </div>
  </div>
</template>
```

## frontend/src/components/DetailModal.vue

```text
<script setup lang="ts">
import { useKlaroStore, type Item } from '../stores/klaro';

const props = defineProps<{ 
  isOpen: boolean;
  item: Item | null;
}>();

const emit = defineEmits(['close', 'edit']);
const store = useKlaroStore();

// CORRECTION ICI : On utilise la bonne action du store
const onToggleCheck = (task: any) => {
  if (props.item) {
    store.toggleSubTask(props.item.ID, task.ID);
  }
};

const getTypeClass = (type: string) => {
  switch(type) {
    case 'OBLIGATION': return 'bg-tag-red-bg text-tag-red-text border-tag-red-bg';
    case 'RESOLUTION': return 'bg-tag-purple-bg text-tag-purple-text border-tag-purple-bg';
    case 'ENVIE': return 'bg-tag-yellow-bg text-tag-yellow-text border-tag-yellow-bg';
    case 'EVENT': return 'bg-tag-blue-bg text-tag-blue-text border-tag-blue-bg';
    default: return 'bg-gray-100 text-gray-500';
  }
};
</script>

<template>
  <div v-if="isOpen && item" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-bg-app/80 backdrop-blur-sm" @click="$emit('close')"></div>

    <div class="relative bg-bg-surface w-full max-w-md rounded-2xl shadow-floating border border-border-main overflow-hidden flex flex-col max-h-[90vh]">
      
      <div class="p-6 pb-2">
        <div class="flex justify-between items-start mb-4">
          <span class="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide border" :class="getTypeClass(item.type)">
            {{ item.type }}
          </span>
          <div class="flex gap-2">
            <button @click="$emit('edit')" class="size-8 flex items-center justify-center rounded-full hover:bg-bg-element text-text-muted transition-colors">
              <span class="material-symbols-outlined text-[18px]">edit</span>
            </button>
            <button @click="$emit('close')" class="size-8 flex items-center justify-center rounded-full hover:bg-bg-element text-text-muted transition-colors">
              <span class="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        </div>
        <h2 class="text-xl font-bold text-text-main leading-snug">{{ item.title }}</h2>
      </div>

      <div class="px-6 py-2 overflow-y-auto custom-scroll flex-1">
        <p v-if="item.description" class="text-sm text-text-muted leading-relaxed mb-6 whitespace-pre-line">
          {{ item.description }}
        </p>

        <div v-if="item.sub_tasks && item.sub_tasks.length > 0" class="flex flex-col gap-2 mb-6">
          <h3 class="text-xs font-bold text-text-muted uppercase mb-1">Checklist</h3>
          <div 
            v-for="task in item.sub_tasks" 
            :key="task.ID"
            @click="onToggleCheck(task)"
            class="flex items-center gap-3 p-2 rounded-lg hover:bg-bg-element/50 cursor-pointer transition-colors group select-none"
          >
            <div 
              class="size-5 rounded border flex items-center justify-center transition-all"
              :class="task.is_done ? 'bg-primary border-primary text-primary-content' : 'border-text-muted/40 group-hover:border-primary'"
            >
              <span v-if="task.is_done" class="material-symbols-outlined text-[14px] font-bold">check</span>
            </div>
            <span class="text-sm font-medium transition-all" :class="task.is_done ? 'text-text-muted line-through' : 'text-text-main'">
              {{ task.content }}
            </span>
          </div>
        </div>
      </div>

      <div class="p-4 border-t border-border-main bg-bg-element/30 flex justify-between items-center text-xs font-bold text-text-muted">
        <span>{{ item.priority }} PRIORITY</span>
        <span v-if="item.date">{{ new Date(item.date).toLocaleDateString('fr-FR') }}</span>
      </div>
    </div>
  </div>
</template>
```

## frontend/src/components/EditModal.vue

```text
<script setup lang="ts">
import { ref, watch } from 'vue';
import { useKlaroStore, type Item } from '../stores/klaro';

const props = defineProps<{ 
  isOpen: boolean,
  item: Item | null 
}>();

const emit = defineEmits(['close']);
const store = useKlaroStore();
const form = ref<Partial<Item>>({});

watch(() => props.item, (newItem) => {
  if (newItem) {
    form.value = JSON.parse(JSON.stringify(newItem));
    if (form.value.date) form.value.date = form.value.date.split('T')[0];
  }
}, { immediate: true });

const save = async () => {
  if (form.value && props.item) {
    if (form.value.date) form.value.date = new Date(form.value.date).toISOString();
    await store.updateItem(form.value as Item);
    emit('close');
  }
};
</script>

<template>
  <div v-if="isOpen && item" class="fixed inset-0 z-50 flex items-center justify-center p-4">
    <!-- Backdrop avec flou -->
    <div class="absolute inset-0 bg-[#0f172a]/60 backdrop-blur-sm transition-opacity" @click="$emit('close')"></div>

    <!-- Modal Card -->
    <div class="relative z-10 w-full max-w-3xl flex flex-col bg-surface-light dark:bg-[#1a1a14] rounded-2xl shadow-2xl border border-border-light dark:border-border-dark overflow-hidden transform transition-all duration-300">
      
      <!-- Décoration Background (Subtile) -->
      <div class="absolute inset-0 pointer-events-none overflow-hidden">
        <div class="absolute -top-[20%] -left-[10%] w-[60%] h-[60%] rounded-full bg-primary/5 blur-3xl"></div>
        <div class="absolute top-[30%] -right-[10%] w-[40%] h-[40%] rounded-full bg-blue-500/5 blur-3xl"></div>
      </div>

      <!-- Header -->
      <div class="flex items-center justify-between px-8 py-5 border-b border-border-light dark:border-border-dark bg-surface-light/80 dark:bg-surface-dark/80 backdrop-blur-md relative z-10">
        <div class="flex items-center gap-2 text-sm text-text-muted-light dark:text-text-muted-dark font-medium">
          <span class="flex items-center gap-1 opacity-70">
            <span class="material-symbols-outlined text-[18px]">folder_open</span>
            Klaro Workspace
          </span>
          <span class="material-symbols-outlined text-[14px] opacity-50">chevron_right</span>
          <span class="text-text-main-light dark:text-white uppercase font-bold tracking-wider">{{ form.type }}</span>
        </div>
        <div class="flex items-center gap-2">
          <button @click="$emit('close')" class="flex items-center justify-center w-8 h-8 rounded-full text-text-muted-light dark:text-text-muted-dark hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 transition-colors">
            <span class="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
      </div>

      <!-- Body -->
      <div class="flex-1 overflow-y-auto px-8 py-8 flex flex-col gap-8 relative z-10">
        
        <!-- Title Input (Design minimaliste) -->
        <div class="group relative">
          <input 
            v-model="form.title"
            class="w-full bg-transparent border-0 border-b-2 border-transparent focus:border-primary focus:ring-0 px-0 py-2 text-3xl font-bold placeholder:text-slate-300 dark:placeholder:text-slate-700 text-text-main-light dark:text-white transition-all outline-none" 
            placeholder="Task Title" 
            type="text"
          />
        </div>

        <!-- Description -->
        <div class="relative">
          <label class="block text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark mb-2">Description</label>
          <textarea 
            v-model="form.description"
            class="w-full min-h-[120px] resize-y rounded-xl bg-bg-light/50 dark:bg-black/20 border border-border-light dark:border-border-dark focus:border-primary focus:ring-1 focus:ring-primary/50 text-base text-text-main-light dark:text-gray-200 p-4 placeholder:text-text-muted-light/50 transition-all" 
            placeholder="Add a detailed description..."
          ></textarea>
        </div>

        <div class="h-px w-full bg-border-light dark:bg-border-dark opacity-50"></div>

        <!-- Properties Grid -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
          
          <!-- Status -->
          <div class="flex flex-col gap-2">
            <label class="text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark">Status</label>
            <div class="relative">
              <select 
                v-model="form.status"
                class="appearance-none w-full bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-lg py-3 px-4 pr-10 text-sm font-medium text-text-main-light dark:text-white focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary cursor-pointer hover:border-slate-300 dark:hover:border-slate-500 transition-colors"
              >
                <option value="TODO">To Do</option>
                <option value="DOING">In Progress</option>
                <option value="DONE">Done</option>
              </select>
              <div class="pointer-events-none absolute inset-y-0 right-0 flex items-center px-3 text-text-muted-light dark:text-text-muted-dark">
                <span class="material-symbols-outlined text-[20px]">unfold_more</span>
              </div>
            </div>
          </div>

          <!-- Priority -->
          <div class="flex flex-col gap-2">
            <label class="text-xs font-bold uppercase tracking-wider text-text-muted-light dark:text-text-muted-dark">Priority</label>
            <div class="flex rounded-lg bg-bg-light dark:bg-black/30 p-1 border border-border-light dark:border-border-dark">
              <button 
                v-for="p in ['LOW', 'MEDIUM', 'HIGH']" :key="p"
                @click="form.priority = p as any"
                class="flex-1 flex items-center justify-center rounded-md py-2 text-xs font-medium transition-all"
                :class="form.priority === p ? 'bg-white dark:bg-surface-dark text-text-main-light dark:text-white shadow-sm' : 'text-text-muted-light dark:text-text-muted-dark hover:text-text-main-light dark:hover:text-white'"
              >
                {{ p }}
              </button>
            </div>
          </div>

          <!-- Lifecycle Dates -->
          <div class="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <label class="flex flex-col gap-1.5 group cursor-pointer">
              <span class="text-xs font-bold text-text-muted-light dark:text-text-muted-dark">Planned Date</span>
              <div class="relative flex items-center">
                <div class="absolute left-3 text-text-muted-light dark:text-text-muted-dark group-hover:text-primary transition-colors">
                  <span class="material-symbols-outlined text-[20px]">calendar_today</span>
                </div>
                <input v-model="form.date" class="w-full bg-surface-light dark:bg-surface-dark border border-border-light dark:border-border-dark rounded-lg py-3 pl-10 pr-3 text-sm text-text-main-light dark:text-white focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition-all cursor-pointer" type="date"/>
              </div>
            </label>
          </div>

        </div>
      </div>

      <!-- Footer -->
      <div class="flex items-center justify-end px-8 py-5 bg-bg-light/50 dark:bg-black/20 border-t border-border-light dark:border-border-dark gap-4 relative z-10">
        <button @click="$emit('close')" class="px-5 py-2.5 rounded-lg text-sm font-medium text-text-muted-light dark:text-text-muted-dark hover:text-text-main-light dark:hover:text-white transition-all">
          Cancel
        </button>
        <button @click="save" class="flex items-center gap-2 px-8 py-2.5 rounded-lg text-sm font-bold text-black bg-primary hover:bg-primary-hover shadow-[0_0_15px_rgba(249,245,6,0.3)] hover:shadow-[0_0_20px_rgba(249,245,6,0.5)] transition-all transform hover:-translate-y-0.5">
          <span>Save Changes</span>
          <span class="material-symbols-outlined text-[18px]">check</span>
        </button>
      </div>

    </div>
  </div>
</template>
```

## frontend/src/components/HelloWorld.vue

```text
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ msg: string }>()

const count = ref(0)
</script>

<template>
  <h1>{{ msg }}</h1>

  <div class="card">
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>
      Edit
      <code>components/HelloWorld.vue</code> to test HMR
    </p>
  </div>

  <p>
    Check out
    <a href="https://vuejs.org/guide/quick-start.html#local" target="_blank"
      >create-vue</a
    >, the official Vue + Vite starter
  </p>
  <p>
    Learn more about IDE Support for Vue in the
    <a
      href="https://vuejs.org/guide/scaling-up/tooling.html#ide-support"
      target="_blank"
      >Vue Docs Scaling up Guide</a
    >.
  </p>
  <p class="read-the-docs">Click on the Vite and Vue logos to learn more</p>
</template>

<style scoped>
.read-the-docs {
  color: #888;
}
</style>

```

## frontend/src/main.ts

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css' // Ton CSS Tailwind v4

// Import de V-Calendar et son CSS
import VCalendar from 'v-calendar';
import 'v-calendar/style.css';

const app = createApp(App)

// 1. Activation du Store (Pinia)
app.use(createPinia())

// 2. Activation du Calendrier (Setup global)
app.use(VCalendar, {
  componentPrefix: 'vc', // On utilisera <vc-calendar /> dans les templates
});

app.mount('#app')
```

## frontend/src/stores/klaro.ts

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:8080';

// --- TYPES EXISTANTS (ITEMS/EVENTS) ---
export interface SubTask {
  ID: number;
  item_id: number;
  content: string;
  is_done: boolean;
}

export interface Item {
  ID: number;
  title: string;
  description?: string;
  type: 'EVENT' | 'ENVIE' | 'RESOLUTION' | 'OBLIGATION';
  status: 'TODO' | 'DOING' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  date?: string;        
  sub_tasks: SubTask[];
}

// --- NOUVEAUX TYPES (EPICS/PROJETS) ---
export interface EpicTask {
  ID: number;
  epic_id: number;
  title: string;
  is_done: boolean;
}

export interface Epic {
  ID: number;
  title: string;
  description?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  start_date: string; // ISO String
  end_date: string;   // ISO String
  tasks: EpicTask[];
}

export const useKlaroStore = defineStore('klaro', () => {
  // STATES
  const items = ref<Item[]>([])
  const epics = ref<Epic[]>([])
  const loading = ref(false)

  // ===========================================================================
  // GETTERS (COMPUTED)
  // ===========================================================================

  // --- ITEMS (Legacy/Event) ---
  const calendarItems = computed(() => items.value.filter((i): i is Item & { date: string } => !!i.date))
  const backlogItems = computed(() => items.value.filter(i => !i.date && i.status !== 'DONE'))
  
  const calendarAttributes = computed(() => {
    return calendarItems.value.map(item => {
      let color = 'gray';
      switch(item.type) {
        case 'EVENT': color = 'blue'; break;
        case 'OBLIGATION': color = 'red'; break;
        case 'RESOLUTION': color = 'purple'; break;
        case 'ENVIE': color = 'yellow'; break;
      }
      return {
        key: `item-${item.ID}`,
        dot: true,
        dates: new Date(item.date),
        customData: item,
        popover: { label: item.title },
        highlight: { color: color, fillMode: 'light' }
      }
    })
  })

  // --- EPICS (Nouveau) ---
  // Transforme les épopées en objets riches pour l'affichage (Barres de temps)
  const epicRanges = computed(() => {
    return epics.value.map(epic => {
      const total = epic.tasks?.length || 0;
      const done = epic.tasks?.filter(t => t.is_done).length || 0;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;

      return {
        ...epic,
        progress,
        // Helper pour savoir si l'épopée est "en retard" (date fin passée et pas 100%)
        isOverdue: new Date(epic.end_date) < new Date() && progress < 100,
        startDateObj: new Date(epic.start_date),
        endDateObj: new Date(epic.end_date)
      }
    }).sort((a, b) => a.startDateObj.getTime() - b.startDateObj.getTime());
  });

  // Focus du jour mélangé (Items importants + Epics en cours)
  const focusItems = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Items du jour ou haute priorité
    const criticalItems = items.value.filter(i => 
      (i.priority === 'HIGH' && i.status !== 'TODO') || 
      (i.date && i.date.startsWith(today!))
    );

    return criticalItems.slice(0, 5);
  });

  const completionRate = computed(() => {
    if (items.value.length === 0) return 0;
    const done = items.value.filter(i => i.status === 'DONE').length;
    return Math.round((done / items.value.length) * 100);
  });

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  async function fetchAll() {
    loading.value = true;
    try {
        await Promise.all([fetchItems(), fetchEpics()]);
    } finally {
        loading.value = false;
    }
  }

  // --- ITEMS ACTIONS ---
  async function fetchItems() {
    try {
      const res = await fetch(`${API_BASE}/api/items`);
      if (res.ok) items.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createItem(newItem: Partial<Item>) {
    try {
      const res = await fetch(`${API_BASE}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newItem, priority: newItem.priority || 'MEDIUM' })
      });
      const created = await res.json();
      items.value.push(created);
    } catch (e) { console.error("Erreur création item", e); }
  }

  async function updateItem(item: Item) {
    const idx = items.value.findIndex(i => i.ID === item.ID);
    if (idx !== -1) items.value[idx] = item;
    // TODO: Connecter le PUT backend quand implémenté
  }

  async function toggleSubTask(itemId: number, taskId: number) {
    // Optimistic
    const item = items.value.find(i => i.ID === itemId);
    if (item) {
        const task = item.sub_tasks.find(t => t.ID === taskId);
        if (task) task.is_done = !task.is_done;
    }
    // API
    try {
      await fetch(`${API_BASE}/api/subtasks/${taskId}/toggle`, { method: 'PATCH' });
    } catch (e) { console.error(e); }
  }

  // --- EPICS ACTIONS (Nouveau) ---

  async function fetchEpics() {
    try {
      const res = await fetch(`${API_BASE}/api/epics`);
      if (res.ok) epics.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createEpic(epic: Partial<Epic>) {
    try {
      const res = await fetch(`${API_BASE}/api/epics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(epic)
      });
      const created = await res.json();
      // On s'assure que le tableau tasks existe
      created.tasks = []; 
      epics.value.push(created);
      return created;
    } catch (e) { console.error("Erreur création epic", e); }
  }

  async function addEpicTask(epicId: number, title: string) {
    try {
      const res = await fetch(`${API_BASE}/api/epics/${epicId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const newTask = await res.json();
      
      // Update local
      const epic = epics.value.find(e => e.ID === epicId);
      if (epic) epic.tasks.push(newTask);
      
      return newTask;
    } catch (e) { console.error("Erreur ajout task epic", e); }
  }

  async function toggleEpicTask(taskId: number) {
    // Optimistic Update (Recherche imbriquée)
    let found = false;
    for (const epic of epics.value) {
        const task = epic.tasks?.find(t => t.ID === taskId);
        if (task) {
            task.is_done = !task.is_done;
            found = true;
            break;
        }
    }
    
    if (found) {
        try {
            await fetch(`${API_BASE}/api/tasks/${taskId}/toggle`, { method: 'PATCH' });
        } catch(e) { console.error(e); }
    }
  }

  return { 
    // State
    items, 
    epics,
    loading, 
    
    // Getters
    calendarItems, 
    backlogItems, 
    focusItems, 
    completionRate,
    calendarAttributes,
    epicRanges, // <-- Le nouveau getter puissant pour le calendrier
    
    // Actions
    fetchAll,
    fetchItems, 
    createItem, 
    updateItem,
    toggleSubTask,
    // Actions Epics
    fetchEpics,
    createEpic,
    addEpicTask,
    toggleEpicTask
  }
});
```

## frontend/src/style.css

```css
@import "tailwindcss";

@theme {
  /* --- TYPOGRAPHIE --- */
  --font-display: "Spline Sans", sans-serif;
  --font-sans: "Spline Sans", sans-serif;

  /* --- COULEURS SEMANTIQUES --- */
  /* Ces variables changent de valeur selon le mode (voir plus bas) */
  
  /* Primaire (Le Jaune Neon) */
  --color-primary: #f9f506;
  --color-primary-hover: #e0dc05;
  --color-primary-content: #18181b;

  /* Arrière-plans */
  --color-bg-app: var(--bg-app);
  --color-bg-surface: var(--bg-surface);
  --color-bg-surface-hover: var(--bg-surface-hover);
  --color-bg-element: var(--bg-element);

  /* Bordures */
  --color-border-main: var(--border-main);
  --color-border-subtle: var(--border-subtle);

  /* Texte */
  --color-text-main: var(--text-main);
  --color-text-muted: var(--text-muted);
  --color-text-inverse: var(--text-inverse);

  /* Status (Pastels) */
  --color-tag-blue-bg: var(--tag-blue-bg);
  --color-tag-blue-text: var(--tag-blue-text);
  --color-tag-yellow-bg: var(--tag-yellow-bg);
  --color-tag-yellow-text: var(--tag-yellow-text);
  --color-tag-red-bg: var(--tag-red-bg);
  --color-tag-red-text: var(--tag-red-text);
  --color-tag-purple-bg: var(--tag-purple-bg);
  --color-tag-purple-text: var(--tag-purple-text);

  /* Ombres */
  --shadow-soft: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
  --shadow-glow: 0 0 20px rgba(249, 245, 6, 0.15);
}

/* --- VALEURS DES VARIABLES --- */
:root {
  /* MODE CLAIR (Par défaut) */
  --bg-app: #f8fafc;        /* Slate 50 */
  --bg-surface: #ffffff;    /* White */
  --bg-surface-hover: #f1f5f9;
  --bg-element: #f1f5f9;    /* Slate 100 */
  
  --border-main: #e2e8f0;   /* Slate 200 */
  --border-subtle: #f1f5f9;
  
  --text-main: #0f172a;     /* Slate 900 */
  --text-muted: #64748b;    /* Slate 500 */
  --text-inverse: #ffffff;

  /* Tags Clair */
  --tag-blue-bg: #e0f2fe; --tag-blue-text: #0369a1;
  --tag-yellow-bg: #fef9c3; --tag-yellow-text: #854d0e;
  --tag-red-bg: #fee2e2; --tag-red-text: #991b1b;
  --tag-purple-bg: #f3e8ff; --tag-purple-text: #6b21a8;
}

:root.dark {
  /* MODE SOMBRE */
  --bg-app: #020617;        /* Slate 950 (Plus profond) */
  --bg-surface: #0f172a;    /* Slate 900 */
  --bg-surface-hover: #1e293b;
  --bg-element: #1e293b;    /* Slate 800 */
  
  --border-main: #1e293b;   /* Slate 800 */
  --border-subtle: #334155;
  
  --text-main: #f8fafc;     /* Slate 50 */
  --text-muted: #94a3b8;    /* Slate 400 */
  --text-inverse: #0f172a;

  /* Tags Sombre (Plus transparents) */
  --tag-blue-bg: rgba(56, 189, 248, 0.15); --tag-blue-text: #7dd3fc;
  --tag-yellow-bg: rgba(253, 224, 71, 0.15); --tag-yellow-text: #fde047;
  --tag-red-bg: rgba(248, 113, 113, 0.15); --tag-red-text: #fca5a5;
  --tag-purple-bg: rgba(192, 132, 252, 0.15); --tag-purple-text: #d8b4fe;
}

/* Base Reset */
html, body {
  background-color: var(--color-bg-app);
  color: var(--color-text-main);
  font-family: var(--font-display);
  height: 100%;
  overflow: hidden;
  /* Transition douce lors du changement de thème */
  transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Material Icons Fix */
.material-symbols-outlined {
  font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  user-select: none; 
}

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-border-main); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }
```

## frontend/tsconfig.app.json

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "types": ["vite/client"],

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
}

```

## frontend/tsconfig.json

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}

```

## frontend/tsconfig.node.json

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "types": ["node"],
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["vite.config.ts"]
}

```

## frontend/vite.config.ts

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(),tailwindcss()],
})

```

## k8s/deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: klaro
  namespace: apps
  labels:
    app: klaro
spec:
  replicas: 1 # Tu pourras augmenter ça plus tard
  selector:
    matchLabels:
      app: klaro
  template:
    metadata:
      labels:
        app: klaro
    spec:
      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001 # <--- K3s fera un chown automatique du volume vers ce groupe
      containers:
        - name: klaro
          # Le tag sera remplacé dynamiquement par la CI/CD
          image: spadmdck/klaro:latest 
          ports:
            - containerPort: 8080 # Le port exposé par ton main.go
          env:
            - name: PORT
              value: "8080"
            - name: DB_PATH
              value: "/data/klaro.db"
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: klaro-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: klaro-pvc
  namespace: apps
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path # Le stockage par défaut de K3s
  resources:
    requests:
      storage: 1Gi
```

## k8s/ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: klaro
  namespace: apps
  annotations:
    # Intégration avec ton Traefik existant
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    traefik.ingress.kubernetes.io/router.tls.certresolver: "le" 
spec:
  ingressClassName: traefik
  rules:
    - host: klaro.dgsynthex.online 
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: klaro
                port:
                  number: 80
```

## k8s/service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: klaro
  namespace: apps
spec:
  selector:
    app: klaro
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
```

## package.json

```json
{
  "name": "klaro",
  "version": "0.2.1",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "packageManager": "pnpm@10.21.0"
}

```

## plan

```text
📦 Feature A : feat/front-store-epics (La Plomberie)
Objectif : Connecter le Frontend à la nouvelle API Backend sans toucher à l'UI.

Contenu :

Mise à jour des types TypeScript dans stores/klaro.ts (Ajout interfaces Epic, EpicTask).

Ajout des actions Pinia : fetchEpics, createEpic, addEpicTask, toggleEpicTask.

Adaptation des getters pour préparer les données du calendrier.

##############################################################
##############################################################
##############################################################
Prompt:
"Mets à jour le fichier frontend/src/stores/klaro.ts. Je veux intégrer la nouvelle logique Backend Epic (Projets sur la durée) tout en gardant Item (Events ponctuels).

Ajoute les interfaces Epic et EpicTask correspondant aux structs Go.

Ajoute un state epics: ref<Epic[]>([]).

Ajoute les actions fetchEpics, createEpic (POST /api/epics), createEpicTask (POST /api/epics/{id}/tasks) et toggleEpicTask.

Crée un getter calendarRanges qui transforme les Epics en objets utilisables pour l'affichage (avec start, end, couleur, % de progression)."
##############################################################
##############################################################
##############################################################



🎨 Feature B : feat/ui-creation-flow (L'Entrée de données)
Objectif : Permettre à l'utilisateur de choisir entre créer un "Event" (Item simple) ou une "Épopée" (Projet long).

Contenu :

Modification de CreateModal.vue.

Ajout d'un système d'onglets : "Tâche Rapide" (Item) vs "Épopée" (Epic).

Formulaire Épopée : Titre, Description, Date Début et Date Fin obligatoires, Priorité.

Pas de sous-tâches à la création de l'épopée (on crée le contenant d'abord).

Prompt
##############################################################
##############################################################
##############################################################
"Modifie frontend/src/components/CreateModal.vue. Je veux séparer la création en deux modes via des onglets en haut de la modale :

Mode 'Event' (L'existant) : Pour les items simples, ponctuels (Date unique ou Backlog).

Mode 'Épopée' (Nouveau) : Pour les projets longs. Champs Épopée : Titre, Description, Priorité (Low/Med/High), Date de Début et Date de Fin (Obligatoires). Le bouton 'Créer' doit appeler la bonne action du store (createItem ou createEpic) selon l'onglet actif."

##############################################################
##############################################################
##############################################################



📅 Feature C : feat/ui-calendar-epics (La Visualisation)
Objectif : Afficher les Épopées comme des barres continues sur le calendrier (timeline) et gérer leurs tâches.

Contenu :

Vue Mois : Afficher des barres colorées qui traversent les cases des jours (style Gantt simplifié).

Vue Semaine : Afficher une section "Projets en cours" en haut de la grille horaire (comme les "All day events" de Google Calendar).

Détail : Créer EpicDetailModal.vue pour voir l'avancement, ajouter des tâches à l'épopée et les cocher.

Prompt
##############################################################
##############################################################
##############################################################
"Mets à jour frontend/src/App.vue pour afficher les Épopées. Dans la Vue Mois (Grille) :

En plus des items ponctuels (points/textes), affiche les Épopées sous forme de barres horizontales colorées.

Ces barres doivent visuellement commencer à start_date et finir à end_date.

Si une épopée traverse plusieurs semaines, gère l'affichage pour qu'elle apparaisse sur les lignes concernées.

Au clic sur une barre d'épopée, ouvre une nouvelle modale EpicDetailModal (à créer) qui permet d'ajouter/cocher des tâches spécifiques à cette épopée."

##############################################################
##############################################################
##############################################################
```

## pnpm-lock.yaml

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  frontend:
    dependencies:
      '@popperjs/core':
        specifier: ^2.11.8
        version: 2.11.8
      '@tailwindcss/vite':
        specifier: ^4.1.18
        version: 4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))
      pinia:
        specifier: ^3.0.4
        version: 3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      v-calendar:
        specifier: ^3.1.2
        version: 3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3))
      vue:
        specifier: ^3.5.24
        version: 3.5.25(typescript@5.9.3)
    devDependencies:
      '@types/node':
        specifier: ^24.10.1
        version: 24.10.4
      '@vitejs/plugin-vue':
        specifier: ^6.0.1
        version: 6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))
      '@vue/tsconfig':
        specifier: ^0.8.1
        version: 0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      autoprefixer:
        specifier: ^10.4.23
        version: 10.4.23(postcss@8.5.6)
      postcss:
        specifier: ^8.5.6
        version: 8.5.6
      tailwindcss:
        specifier: ^4.1.18
        version: 4.1.18
      typescript:
        specifier: ~5.9.3
        version: 5.9.3
      vite:
        specifier: ^7.2.4
        version: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue-tsc:
        specifier: ^3.1.4
        version: 3.1.8(typescript@5.9.3)

packages:

  '@babel/helper-string-parser@7.27.1':
    resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
    engines: {node: '>=6.9.0'}

  '@babel/helper-validator-identifier@7.28.5':
    resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
    engines: {node: '>=6.9.0'}

  '@babel/parser@7.28.5':
    resolution: {integrity: sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  '@babel/runtime@7.28.4':
    resolution: {integrity: sha512-Q/N6JNWvIvPnLDvjlE1OUBLPQHH6l3CltCEsHIujp45zQUSSh8K+gHnaEX45yAT1nyngnINhvWtzN+Nb9D8RAQ==}
    engines: {node: '>=6.9.0'}

  '@babel/types@7.28.5':
    resolution: {integrity: sha512-qQ5m48eI/MFLQ5PxQj4PFaprjyCTLI37ElWMmNs0K8Lk3dVeOdNpB3ks8jc7yM5CDmVC73eMVk/trk3fgmrUpA==}
    engines: {node: '>=6.9.0'}

  '@esbuild/aix-ppc64@0.27.2':
    resolution: {integrity: sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.27.2':
    resolution: {integrity: sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.27.2':
    resolution: {integrity: sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.27.2':
    resolution: {integrity: sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.27.2':
    resolution: {integrity: sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.27.2':
    resolution: {integrity: sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.27.2':
    resolution: {integrity: sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.27.2':
    resolution: {integrity: sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.27.2':
    resolution: {integrity: sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.27.2':
    resolution: {integrity: sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.27.2':
    resolution: {integrity: sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.27.2':
    resolution: {integrity: sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.27.2':
    resolution: {integrity: sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.27.2':
    resolution: {integrity: sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.27.2':
    resolution: {integrity: sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.27.2':
    resolution: {integrity: sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.27.2':
    resolution: {integrity: sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.27.2':
    resolution: {integrity: sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.27.2':
    resolution: {integrity: sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.27.2':
    resolution: {integrity: sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.27.2':
    resolution: {integrity: sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.27.2':
    resolution: {integrity: sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.27.2':
    resolution: {integrity: sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.27.2':
    resolution: {integrity: sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.27.2':
    resolution: {integrity: sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.27.2':
    resolution: {integrity: sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/gen-mapping@0.3.13':
    resolution: {integrity: sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==}

  '@jridgewell/remapping@2.3.5':
    resolution: {integrity: sha512-LI9u/+laYG4Ds1TDKSJW2YPrIlcVYOwi2fUC6xB43lueCjgxV4lffOCZCtYFiH6TNOX+tQKXx97T4IKHbhyHEQ==}

  '@jridgewell/resolve-uri@3.1.2':
    resolution: {integrity: sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==}
    engines: {node: '>=6.0.0'}

  '@jridgewell/sourcemap-codec@1.5.5':
    resolution: {integrity: sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==}

  '@jridgewell/trace-mapping@0.3.31':
    resolution: {integrity: sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==}

  '@popperjs/core@2.11.8':
    resolution: {integrity: sha512-P1st0aksCrn9sGZhp8GMYwBnQsbvAWsZAX44oXNNvLHGqAOcoVxmjZiohstwQ7SqKnbR47akdNi+uleWD8+g6A==}

  '@rolldown/pluginutils@1.0.0-beta.53':
    resolution: {integrity: sha512-vENRlFU4YbrwVqNDZ7fLvy+JR1CRkyr01jhSiDpE1u6py3OMzQfztQU2jxykW3ALNxO4kSlqIDeYyD0Y9RcQeQ==}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    resolution: {integrity: sha512-iDGS/h7D8t7tvZ1t6+WPK04KD0MwzLZrG0se1hzBjSi5fyxlsiggoJHwh18PCFNn7tG43OWb6pdZ6Y+rMlmyNQ==}
    cpu: [arm]
    os: [android]

  '@rollup/rollup-android-arm64@4.53.5':
    resolution: {integrity: sha512-wrSAViWvZHBMMlWk6EJhvg8/rjxzyEhEdgfMMjREHEq11EtJ6IP6yfcCH57YAEca2Oe3FNCE9DSTgU70EIGmVw==}
    cpu: [arm64]
    os: [android]

  '@rollup/rollup-darwin-arm64@4.53.5':
    resolution: {integrity: sha512-S87zZPBmRO6u1YXQLwpveZm4JfPpAa6oHBX7/ghSiGH3rz/KDgAu1rKdGutV+WUI6tKDMbaBJomhnT30Y2t4VQ==}
    cpu: [arm64]
    os: [darwin]

  '@rollup/rollup-darwin-x64@4.53.5':
    resolution: {integrity: sha512-YTbnsAaHo6VrAczISxgpTva8EkfQus0VPEVJCEaboHtZRIb6h6j0BNxRBOwnDciFTZLDPW5r+ZBmhL/+YpTZgA==}
    cpu: [x64]
    os: [darwin]

  '@rollup/rollup-freebsd-arm64@4.53.5':
    resolution: {integrity: sha512-1T8eY2J8rKJWzaznV7zedfdhD1BqVs1iqILhmHDq/bqCUZsrMt+j8VCTHhP0vdfbHK3e1IQ7VYx3jlKqwlf+vw==}
    cpu: [arm64]
    os: [freebsd]

  '@rollup/rollup-freebsd-x64@4.53.5':
    resolution: {integrity: sha512-sHTiuXyBJApxRn+VFMaw1U+Qsz4kcNlxQ742snICYPrY+DDL8/ZbaC4DVIB7vgZmp3jiDaKA0WpBdP0aqPJoBQ==}
    cpu: [x64]
    os: [freebsd]

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    resolution: {integrity: sha512-dV3T9MyAf0w8zPVLVBptVlzaXxka6xg1f16VAQmjg+4KMSTWDvhimI/Y6mp8oHwNrmnmVl9XxJ/w/mO4uIQONA==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    resolution: {integrity: sha512-wIGYC1x/hyjP+KAu9+ewDI+fi5XSNiUi9Bvg6KGAh2TsNMA3tSEs+Sh6jJ/r4BV/bx/CyWu2ue9kDnIdRyafcQ==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    resolution: {integrity: sha512-Y+qVA0D9d0y2FRNiG9oM3Hut/DgODZbU9I8pLLPwAsU0tUKZ49cyV1tzmB/qRbSzGvY8lpgGkJuMyuhH7Ma+Vg==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    resolution: {integrity: sha512-juaC4bEgJsyFVfqhtGLz8mbopaWD+WeSOYr5E16y+1of6KQjc0BpwZLuxkClqY1i8sco+MdyoXPNiCkQou09+g==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    resolution: {integrity: sha512-rIEC0hZ17A42iXtHX+EPJVL/CakHo+tT7W0pbzdAGuWOt2jxDFh7A/lRhsNHBcqL4T36+UiAgwO8pbmn3dE8wA==}
    cpu: [loong64]
    os: [linux]

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    resolution: {integrity: sha512-T7l409NhUE552RcAOcmJHj3xyZ2h7vMWzcwQI0hvn5tqHh3oSoclf9WgTl+0QqffWFG8MEVZZP1/OBglKZx52Q==}
    cpu: [ppc64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    resolution: {integrity: sha512-7OK5/GhxbnrMcxIFoYfhV/TkknarkYC1hqUw1wU2xUN3TVRLNT5FmBv4KkheSG2xZ6IEbRAhTooTV2+R5Tk0lQ==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    resolution: {integrity: sha512-GwuDBE/PsXaTa76lO5eLJTyr2k8QkPipAyOrs4V/KJufHCZBJ495VCGJol35grx9xryk4V+2zd3Ri+3v7NPh+w==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    resolution: {integrity: sha512-IAE1Ziyr1qNfnmiQLHBURAD+eh/zH1pIeJjeShleII7Vj8kyEm2PF77o+lf3WTHDpNJcu4IXJxNO0Zluro8bOw==}
    cpu: [s390x]
    os: [linux]

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    resolution: {integrity: sha512-Pg6E+oP7GvZ4XwgRJBuSXZjcqpIW3yCBhK4BcsANvb47qMvAbCjR6E+1a/U2WXz1JJxp9/4Dno3/iSJLcm5auw==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.53.5':
    resolution: {integrity: sha512-txGtluxDKTxaMDzUduGP0wdfng24y1rygUMnmlUJ88fzCCULCLn7oE5kb2+tRB+MWq1QDZT6ObT5RrR8HFRKqg==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-openharmony-arm64@4.53.5':
    resolution: {integrity: sha512-3DFiLPnTxiOQV993fMc+KO8zXHTcIjgaInrqlG8zDp1TlhYl6WgrOHuJkJQ6M8zHEcntSJsUp1XFZSY8C1DYbg==}
    cpu: [arm64]
    os: [openharmony]

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    resolution: {integrity: sha512-nggc/wPpNTgjGg75hu+Q/3i32R00Lq1B6N1DO7MCU340MRKL3WZJMjA9U4K4gzy3dkZPXm9E1Nc81FItBVGRlA==}
    cpu: [arm64]
    os: [win32]

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    resolution: {integrity: sha512-U/54pTbdQpPLBdEzCT6NBCFAfSZMvmjr0twhnD9f4EIvlm9wy3jjQ38yQj1AGznrNO65EWQMgm/QUjuIVrYF9w==}
    cpu: [ia32]
    os: [win32]

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    resolution: {integrity: sha512-2NqKgZSuLH9SXBBV2dWNRCZmocgSOx8OJSdpRaEcRlIfX8YrKxUT6z0F1NpvDVhOsl190UFTRh2F2WDWWCYp3A==}
    cpu: [x64]
    os: [win32]

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    resolution: {integrity: sha512-JRpZUhCfhZ4keB5v0fe02gQJy05GqboPOaxvjugW04RLSYYoB/9t2lx2u/tMs/Na/1NXfY8QYjgRljRpN+MjTQ==}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/node@4.1.18':
    resolution: {integrity: sha512-DoR7U1P7iYhw16qJ49fgXUlry1t4CpXeErJHnQ44JgTSKMaZUdf17cfn5mHchfJ4KRBZRFA/Coo+MUF5+gOaCQ==}

  '@tailwindcss/oxide-android-arm64@4.1.18':
    resolution: {integrity: sha512-dJHz7+Ugr9U/diKJA0W6N/6/cjI+ZTAoxPf9Iz9BFRF2GzEX8IvXxFIi/dZBloVJX/MZGvRuFA9rqwdiIEZQ0Q==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [android]

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    resolution: {integrity: sha512-Gc2q4Qhs660bhjyBSKgq6BYvwDz4G+BuyJ5H1xfhmDR3D8HnHCmT/BSkvSL0vQLy/nkMLY20PQ2OoYMO15Jd0A==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [darwin]

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    resolution: {integrity: sha512-FL5oxr2xQsFrc3X9o1fjHKBYBMD1QZNyc1Xzw/h5Qu4XnEBi3dZn96HcHm41c/euGV+GRiXFfh2hUCyKi/e+yw==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [darwin]

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    resolution: {integrity: sha512-Fj+RHgu5bDodmV1dM9yAxlfJwkkWvLiRjbhuO2LEtwtlYlBgiAT4x/j5wQr1tC3SANAgD+0YcmWVrj8R9trVMA==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [freebsd]

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    resolution: {integrity: sha512-Fp+Wzk/Ws4dZn+LV2Nqx3IilnhH51YZoRaYHQsVq3RQvEl+71VGKFpkfHrLM/Li+kt5c0DJe/bHXK1eHgDmdiA==}
    engines: {node: '>= 10'}
    cpu: [arm]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    resolution: {integrity: sha512-S0n3jboLysNbh55Vrt7pk9wgpyTTPD0fdQeh7wQfMqLPM/Hrxi+dVsLsPrycQjGKEQk85Kgbx+6+QnYNiHalnw==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    resolution: {integrity: sha512-1px92582HkPQlaaCkdRcio71p8bc8i/ap5807tPRDK/uw953cauQBT8c5tVGkOwrHMfc2Yh6UuxaH4vtTjGvHg==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    resolution: {integrity: sha512-v3gyT0ivkfBLoZGF9LyHmts0Isc8jHZyVcbzio6Wpzifg/+5ZJpDiRiUhDLkcr7f/r38SWNe7ucxmGW3j3Kb/g==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    resolution: {integrity: sha512-bhJ2y2OQNlcRwwgOAGMY0xTFStt4/wyU6pvI6LSuZpRgKQwxTec0/3Scu91O8ir7qCR3AuepQKLU/kX99FouqQ==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    resolution: {integrity: sha512-LffYTvPjODiP6PT16oNeUQJzNVyJl1cjIebq/rWWBF+3eDst5JGEFSc5cWxyRCJ0Mxl+KyIkqRxk1XPEs9x8TA==}
    engines: {node: '>=14.0.0'}
    cpu: [wasm32]
    bundledDependencies:
      - '@napi-rs/wasm-runtime'
      - '@emnapi/core'
      - '@emnapi/runtime'
      - '@tybys/wasm-util'
      - '@emnapi/wasi-threads'
      - tslib

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    resolution: {integrity: sha512-HjSA7mr9HmC8fu6bdsZvZ+dhjyGCLdotjVOgLA2vEqxEBZaQo9YTX4kwgEvPCpRh8o4uWc4J/wEoFzhEmjvPbA==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [win32]

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    resolution: {integrity: sha512-bJWbyYpUlqamC8dpR7pfjA0I7vdF6t5VpUGMWRkXVE3AXgIZjYUYAK7II1GNaxR8J1SSrSrppRar8G++JekE3Q==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/oxide@4.1.18':
    resolution: {integrity: sha512-EgCR5tTS5bUSKQgzeMClT6iCY3ToqE1y+ZB0AKldj809QXk1Y+3jB0upOYZrn9aGIzPtUsP7sX4QQ4XtjBB95A==}
    engines: {node: '>= 10'}

  '@tailwindcss/vite@4.1.18':
    resolution: {integrity: sha512-jVA+/UpKL1vRLg6Hkao5jldawNmRo7mQYrZtNHMIVpLfLhDml5nMRUo/8MwoX2vNXvnaXNNMedrMfMugAVX1nA==}
    peerDependencies:
      vite: ^5.2.0 || ^6 || ^7

  '@types/estree@1.0.8':
    resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}

  '@types/lodash@4.17.21':
    resolution: {integrity: sha512-FOvQ0YPD5NOfPgMzJihoT+Za5pdkDJWcbpuj1DjaKZIr/gxodQjY/uWEFlTNqW2ugXHUiL8lRQgw63dzKHZdeQ==}

  '@types/node@24.10.4':
    resolution: {integrity: sha512-vnDVpYPMzs4wunl27jHrfmwojOGKya0xyM3sH+UE5iv5uPS6vX7UIoh6m+vQc5LGBq52HBKPIn/zcSZVzeDEZg==}

  '@types/resize-observer-browser@0.1.11':
    resolution: {integrity: sha512-cNw5iH8JkMkb3QkCoe7DaZiawbDQEUX8t7iuQaRTyLOyQCR2h+ibBD4GJt7p5yhUHrlOeL7ZtbxNHeipqNsBzQ==}

  '@vitejs/plugin-vue@6.0.3':
    resolution: {integrity: sha512-TlGPkLFLVOY3T7fZrwdvKpjprR3s4fxRln0ORDo1VQ7HHyxJwTlrjKU3kpVWTlaAjIEuCTokmjkZnr8Tpc925w==}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0
      vue: ^3.2.25

  '@volar/language-core@2.4.26':
    resolution: {integrity: sha512-hH0SMitMxnB43OZpyF1IFPS9bgb2I3bpCh76m2WEK7BE0A0EzpYsRp0CCH2xNKshr7kacU5TQBLYn4zj7CG60A==}

  '@volar/source-map@2.4.26':
    resolution: {integrity: sha512-JJw0Tt/kSFsIRmgTQF4JSt81AUSI1aEye5Zl65EeZ8H35JHnTvFGmpDOBn5iOxd48fyGE+ZvZBp5FcgAy/1Qhw==}

  '@volar/typescript@2.4.26':
    resolution: {integrity: sha512-N87ecLD48Sp6zV9zID/5yuS1+5foj0DfuYGdQ6KHj/IbKvyKv1zNX6VCmnKYwtmHadEO6mFc2EKISiu3RDPAvA==}

  '@vue/compiler-core@3.5.25':
    resolution: {integrity: sha512-vay5/oQJdsNHmliWoZfHPoVZZRmnSWhug0BYT34njkYTPqClh3DNWLkZNJBVSjsNMrg0CCrBfoKkjZQPM/QVUw==}

  '@vue/compiler-dom@3.5.25':
    resolution: {integrity: sha512-4We0OAcMZsKgYoGlMjzYvaoErltdFI2/25wqanuTu+S4gismOTRTBPi4IASOjxWdzIwrYSjnqONfKvuqkXzE2Q==}

  '@vue/compiler-sfc@3.5.25':
    resolution: {integrity: sha512-PUgKp2rn8fFsI++lF2sO7gwO2d9Yj57Utr5yEsDf3GNaQcowCLKL7sf+LvVFvtJDXUp/03+dC6f2+LCv5aK1ag==}

  '@vue/compiler-ssr@3.5.25':
    resolution: {integrity: sha512-ritPSKLBcParnsKYi+GNtbdbrIE1mtuFEJ4U1sWeuOMlIziK5GtOL85t5RhsNy4uWIXPgk+OUdpnXiTdzn8o3A==}

  '@vue/devtools-api@7.7.9':
    resolution: {integrity: sha512-kIE8wvwlcZ6TJTbNeU2HQNtaxLx3a84aotTITUuL/4bzfPxzajGBOoqjMhwZJ8L9qFYDU/lAYMEEm11dnZOD6g==}

  '@vue/devtools-kit@7.7.9':
    resolution: {integrity: sha512-PyQ6odHSgiDVd4hnTP+aDk2X4gl2HmLDfiyEnn3/oV+ckFDuswRs4IbBT7vacMuGdwY/XemxBoh302ctbsptuA==}

  '@vue/devtools-shared@7.7.9':
    resolution: {integrity: sha512-iWAb0v2WYf0QWmxCGy0seZNDPdO3Sp5+u78ORnyeonS6MT4PC7VPrryX2BpMJrwlDeaZ6BD4vP4XKjK0SZqaeA==}

  '@vue/language-core@3.1.8':
    resolution: {integrity: sha512-PfwAW7BLopqaJbneChNL6cUOTL3GL+0l8paYP5shhgY5toBNidWnMXWM+qDwL7MC9+zDtzCF2enT8r6VPu64iw==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  '@vue/reactivity@3.5.25':
    resolution: {integrity: sha512-5xfAypCQepv4Jog1U4zn8cZIcbKKFka3AgWHEFQeK65OW+Ys4XybP6z2kKgws4YB43KGpqp5D/K3go2UPPunLA==}

  '@vue/runtime-core@3.5.25':
    resolution: {integrity: sha512-Z751v203YWwYzy460bzsYQISDfPjHTl+6Zzwo/a3CsAf+0ccEjQ8c+0CdX1WsumRTHeywvyUFtW6KvNukT/smA==}

  '@vue/runtime-dom@3.5.25':
    resolution: {integrity: sha512-a4WrkYFbb19i9pjkz38zJBg8wa/rboNERq3+hRRb0dHiJh13c+6kAbgqCPfMaJ2gg4weWD3APZswASOfmKwamA==}

  '@vue/server-renderer@3.5.25':
    resolution: {integrity: sha512-UJaXR54vMG61i8XNIzTSf2Q7MOqZHpp8+x3XLGtE3+fL+nQd+k7O5+X3D/uWrnQXOdMw5VPih+Uremcw+u1woQ==}
    peerDependencies:
      vue: 3.5.25

  '@vue/shared@3.5.25':
    resolution: {integrity: sha512-AbOPdQQnAnzs58H2FrrDxYj/TJfmeS2jdfEEhgiKINy+bnOANmVizIEgq1r+C5zsbs6l1CCQxtcj71rwNQ4jWg==}

  '@vue/tsconfig@0.8.1':
    resolution: {integrity: sha512-aK7feIWPXFSUhsCP9PFqPyFOcz4ENkb8hZ2pneL6m2UjCkccvaOhC/5KCKluuBufvp2KzkbdA2W2pk20vLzu3g==}
    peerDependencies:
      typescript: 5.x
      vue: ^3.4.0
    peerDependenciesMeta:
      typescript:
        optional: true
      vue:
        optional: true

  alien-signals@3.1.1:
    resolution: {integrity: sha512-ogkIWbVrLwKtHY6oOAXaYkAxP+cTH7V5FZ5+Tm4NZFd8VDZ6uNMDrfzqctTZ42eTMCSR3ne3otpcxmqSnFfPYA==}

  autoprefixer@10.4.23:
    resolution: {integrity: sha512-YYTXSFulfwytnjAPlw8QHncHJmlvFKtczb8InXaAx9Q0LbfDnfEYDE55omerIJKihhmU61Ft+cAOSzQVaBUmeA==}
    engines: {node: ^10 || ^12 || >=14}
    hasBin: true
    peerDependencies:
      postcss: ^8.1.0

  baseline-browser-mapping@2.9.9:
    resolution: {integrity: sha512-V8fbOCSeOFvlDj7LLChUcqbZrdKD9RU/VR260piF1790vT0mfLSwGc/Qzxv3IqiTukOpNtItePa0HBpMAj7MDg==}
    hasBin: true

  birpc@2.9.0:
    resolution: {integrity: sha512-KrayHS5pBi69Xi9JmvoqrIgYGDkD6mcSe/i6YKi3w5kekCLzrX4+nawcXqrj2tIp50Kw/mT/s3p+GVK0A0sKxw==}

  browserslist@4.28.1:
    resolution: {integrity: sha512-ZC5Bd0LgJXgwGqUknZY/vkUQ04r8NXnJZ3yYi4vDmSiZmC/pdSN0NbNRPxZpbtO4uAfDUAFffO8IZoM3Gj8IkA==}
    engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
    hasBin: true

  caniuse-lite@1.0.30001760:
    resolution: {integrity: sha512-7AAMPcueWELt1p3mi13HR/LHH0TJLT11cnwDJEs3xA4+CK/PLKeO9Kl1oru24htkyUKtkGCvAx4ohB0Ttry8Dw==}

  copy-anything@4.0.5:
    resolution: {integrity: sha512-7Vv6asjS4gMOuILabD3l739tsaxFQmC+a7pLZm02zyvs8p977bL3zEgq3yDk5rn9B0PbYgIv++jmHcuUab4RhA==}
    engines: {node: '>=18'}

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  date-fns-tz@2.0.1:
    resolution: {integrity: sha512-fJCG3Pwx8HUoLhkepdsP7Z5RsucUi+ZBOxyM5d0ZZ6c4SdYustq0VMmOu6Wf7bli+yS/Jwp91TOCqn9jMcVrUA==}
    peerDependencies:
      date-fns: 2.x

  date-fns@2.30.0:
    resolution: {integrity: sha512-fnULvOpxnC5/Vg3NCiWelDsLiUc9bRwAPs/+LfTLNvetFCtCTN+yQz15C/fs4AwX1R9K5GLtLfn8QW+dWisaAw==}
    engines: {node: '>=0.11'}

  detect-libc@2.1.2:
    resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
    engines: {node: '>=8'}

  electron-to-chromium@1.5.267:
    resolution: {integrity: sha512-0Drusm6MVRXSOJpGbaSVgcQsuB4hEkMpHXaVstcPmhu5LIedxs1xNK/nIxmQIU/RPC0+1/o0AVZfBTkTNJOdUw==}

  enhanced-resolve@5.18.4:
    resolution: {integrity: sha512-LgQMM4WXU3QI+SYgEc2liRgznaD5ojbmY3sb8LxyguVkIg5FxdpTkvk72te2R38/TGKxH634oLxXRGY6d7AP+Q==}
    engines: {node: '>=10.13.0'}

  entities@4.5.0:
    resolution: {integrity: sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==}
    engines: {node: '>=0.12'}

  esbuild@0.27.2:
    resolution: {integrity: sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==}
    engines: {node: '>=18'}
    hasBin: true

  escalade@3.2.0:
    resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
    engines: {node: '>=6'}

  estree-walker@2.0.2:
    resolution: {integrity: sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==}

  fdir@6.5.0:
    resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
    engines: {node: '>=12.0.0'}
    peerDependencies:
      picomatch: ^3 || ^4
    peerDependenciesMeta:
      picomatch:
        optional: true

  fraction.js@5.3.4:
    resolution: {integrity: sha512-1X1NTtiJphryn/uLQz3whtY6jK3fTqoE3ohKs0tT+Ujr1W59oopxmoEh7Lu5p6vBaPbgoM0bzveAW4Qi5RyWDQ==}

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  graceful-fs@4.2.11:
    resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}

  hookable@5.5.3:
    resolution: {integrity: sha512-Yc+BQe8SvoXH1643Qez1zqLRmbA5rCL+sSmk6TVos0LWVfNIB7PGncdlId77WzLGSIB5KaWgTaNTs2lNVEI6VQ==}

  is-what@5.5.0:
    resolution: {integrity: sha512-oG7cgbmg5kLYae2N5IVd3jm2s+vldjxJzK1pcu9LfpGuQ93MQSzo0okvRna+7y5ifrD+20FE8FvjusyGaz14fw==}
    engines: {node: '>=18'}

  jiti@2.6.1:
    resolution: {integrity: sha512-ekilCSN1jwRvIbgeg/57YFh8qQDNbwDb9xT/qu2DAHbFFZUicIl4ygVaAvzveMhMVr3LnpSKTNnwt8PoOfmKhQ==}
    hasBin: true

  lightningcss-android-arm64@1.30.2:
    resolution: {integrity: sha512-BH9sEdOCahSgmkVhBLeU7Hc9DWeZ1Eb6wNS6Da8igvUwAe0sqROHddIlvU06q3WyXVEOYDZ6ykBZQnjTbmo4+A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [android]

  lightningcss-darwin-arm64@1.30.2:
    resolution: {integrity: sha512-ylTcDJBN3Hp21TdhRT5zBOIi73P6/W0qwvlFEk22fkdXchtNTOU4Qc37SkzV+EKYxLouZ6M4LG9NfZ1qkhhBWA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [darwin]

  lightningcss-darwin-x64@1.30.2:
    resolution: {integrity: sha512-oBZgKchomuDYxr7ilwLcyms6BCyLn0z8J0+ZZmfpjwg9fRVZIR5/GMXd7r9RH94iDhld3UmSjBM6nXWM2TfZTQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [darwin]

  lightningcss-freebsd-x64@1.30.2:
    resolution: {integrity: sha512-c2bH6xTrf4BDpK8MoGG4Bd6zAMZDAXS569UxCAGcA7IKbHNMlhGQ89eRmvpIUGfKWNVdbhSbkQaWhEoMGmGslA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [freebsd]

  lightningcss-linux-arm-gnueabihf@1.30.2:
    resolution: {integrity: sha512-eVdpxh4wYcm0PofJIZVuYuLiqBIakQ9uFZmipf6LF/HRj5Bgm0eb3qL/mr1smyXIS1twwOxNWndd8z0E374hiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm]
    os: [linux]

  lightningcss-linux-arm64-gnu@1.30.2:
    resolution: {integrity: sha512-UK65WJAbwIJbiBFXpxrbTNArtfuznvxAJw4Q2ZGlU8kPeDIWEX1dg3rn2veBVUylA2Ezg89ktszWbaQnxD/e3A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-arm64-musl@1.30.2:
    resolution: {integrity: sha512-5Vh9dGeblpTxWHpOx8iauV02popZDsCYMPIgiuw97OJ5uaDsL86cnqSFs5LZkG3ghHoX5isLgWzMs+eD1YzrnA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-x64-gnu@1.30.2:
    resolution: {integrity: sha512-Cfd46gdmj1vQ+lR6VRTTadNHu6ALuw2pKR9lYq4FnhvgBc4zWY1EtZcAc6EffShbb1MFrIPfLDXD6Xprbnni4w==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-linux-x64-musl@1.30.2:
    resolution: {integrity: sha512-XJaLUUFXb6/QG2lGIW6aIk6jKdtjtcffUT0NKvIqhSBY3hh9Ch+1LCeH80dR9q9LBjG3ewbDjnumefsLsP6aiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-win32-arm64-msvc@1.30.2:
    resolution: {integrity: sha512-FZn+vaj7zLv//D/192WFFVA0RgHawIcHqLX9xuWiQt7P0PtdFEVaxgF9rjM/IRYHQXNnk61/H/gb2Ei+kUQ4xQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [win32]

  lightningcss-win32-x64-msvc@1.30.2:
    resolution: {integrity: sha512-5g1yc73p+iAkid5phb4oVFMB45417DkRevRbt/El/gKXJk4jid+vPFF/AXbxn05Aky8PapwzZrdJShv5C0avjw==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [win32]

  lightningcss@1.30.2:
    resolution: {integrity: sha512-utfs7Pr5uJyyvDETitgsaqSyjCb2qNRAtuqUeWIAKztsOYdcACf2KtARYXg2pSvhkt+9NfoaNY7fxjl6nuMjIQ==}
    engines: {node: '>= 12.0.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}

  magic-string@0.30.21:
    resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}

  mitt@3.0.1:
    resolution: {integrity: sha512-vKivATfr97l2/QBCYAkXYDbrIWPM2IIKEl7YPhjCvKlG3kE2gm+uBo6nEXK3M5/Ffh/FLpKExzOQ3JJoJGFKBw==}

  muggle-string@0.4.1:
    resolution: {integrity: sha512-VNTrAak/KhO2i8dqqnqnAHOa3cYBwXEZe9h+D5h/1ZqFSTEFHdM65lR7RoIqq3tBBYavsOXV84NoHXZ0AkPyqQ==}

  nanoid@3.3.11:
    resolution: {integrity: sha512-N8SpfPUnUp1bK+PMYW8qSWdl9U+wwNWI4QKxOYDy9JAro3WMX7p2OeVRF9v+347pnakNevPmiHhNmZ2HbFA76w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  node-releases@2.0.27:
    resolution: {integrity: sha512-nmh3lCkYZ3grZvqcCH+fjmQ7X+H0OeZgP40OierEaAptX4XofMh5kwNbWh7lBduUzCcV/8kZ+NDLCwm2iorIlA==}

  path-browserify@1.0.1:
    resolution: {integrity: sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==}

  perfect-debounce@1.0.0:
    resolution: {integrity: sha512-xCy9V055GLEqoFaHoC1SoLIaLmWctgCUaBaWxDZ7/Zx4CTyX7cJQLJOok/orfjZAh9kEYpjJa4d0KcJmCbctZA==}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  picomatch@4.0.3:
    resolution: {integrity: sha512-5gTmgEY/sqK6gFXLIsQNH19lWb4ebPDLA4SdLP7dsWkIXHWlG66oPuVvXSGFPppYZz8ZDZq0dYYrbHfBCVUb1Q==}
    engines: {node: '>=12'}

  pinia@3.0.4:
    resolution: {integrity: sha512-l7pqLUFTI/+ESXn6k3nu30ZIzW5E2WZF/LaHJEpoq6ElcLD+wduZoB2kBN19du6K/4FDpPMazY2wJr+IndBtQw==}
    peerDependencies:
      typescript: '>=4.5.0'
      vue: ^3.5.11
    peerDependenciesMeta:
      typescript:
        optional: true

  postcss-value-parser@4.2.0:
    resolution: {integrity: sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==}

  postcss@8.5.6:
    resolution: {integrity: sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==}
    engines: {node: ^10 || ^12 || >=14}

  rfdc@1.4.1:
    resolution: {integrity: sha512-q1b3N5QkRUWUl7iyylaaj3kOpIT0N2i9MqIEQXP73GVsN9cw3fdx8X63cEmWhJGi2PPCF23Ijp7ktmd39rawIA==}

  rollup@4.53.5:
    resolution: {integrity: sha512-iTNAbFSlRpcHeeWu73ywU/8KuU/LZmNCSxp6fjQkJBD3ivUb8tpDrXhIxEzA05HlYMEwmtaUnb3RP+YNv162OQ==}
    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
    hasBin: true

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  speakingurl@14.0.1:
    resolution: {integrity: sha512-1POYv7uv2gXoyGFpBCmpDVSNV74IfsWlDW216UPjbWufNf+bSU6GdbDsxdcxtfwb4xlI3yxzOTKClUosxARYrQ==}
    engines: {node: '>=0.10.0'}

  superjson@2.2.6:
    resolution: {integrity: sha512-H+ue8Zo4vJmV2nRjpx86P35lzwDT3nItnIsocgumgr0hHMQ+ZGq5vrERg9kJBo5AWGmxZDhzDo+WVIJqkB0cGA==}
    engines: {node: '>=16'}

  tailwindcss@4.1.18:
    resolution: {integrity: sha512-4+Z+0yiYyEtUVCScyfHCxOYP06L5Ne+JiHhY2IjR2KWMIWhJOYZKLSGZaP5HkZ8+bY0cxfzwDE5uOmzFXyIwxw==}

  tapable@2.3.0:
    resolution: {integrity: sha512-g9ljZiwki/LfxmQADO3dEY1CbpmXT5Hm2fJ+QaGKwSXUylMybePR7/67YW7jOrrvjEgL1Fmz5kzyAjWVWLlucg==}
    engines: {node: '>=6'}

  tinyglobby@0.2.15:
    resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
    engines: {node: '>=12.0.0'}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.16.0:
    resolution: {integrity: sha512-Zz+aZWSj8LE6zoxD+xrjh4VfkIG8Ya6LvYkZqtUQGJPZjYl53ypCaUwWqo7eI0x66KBGeRo+mlBEkMSeSZ38Nw==}

  update-browserslist-db@1.2.3:
    resolution: {integrity: sha512-Js0m9cx+qOgDxo0eMiFGEueWztz+d4+M3rGlmKPT+T4IS/jP4ylw3Nwpu6cpTTP8R1MAC1kF4VbdLt3ARf209w==}
    hasBin: true
    peerDependencies:
      browserslist: '>= 4.21.0'

  v-calendar@3.1.2:
    resolution: {integrity: sha512-QDWrnp4PWCpzUblctgo4T558PrHgHzDtQnTeUNzKxfNf29FkCeFpwGd9bKjAqktaa2aJLcyRl45T5ln1ku34kg==}
    peerDependencies:
      '@popperjs/core': ^2.0.0
      vue: ^3.2.0

  vite@7.3.0:
    resolution: {integrity: sha512-dZwN5L1VlUBewiP6H9s2+B3e3Jg96D0vzN+Ry73sOefebhYr9f94wwkMNN/9ouoU8pV1BqA1d1zGk8928cx0rg==}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true
    peerDependencies:
      '@types/node': ^20.19.0 || >=22.12.0
      jiti: '>=1.21.0'
      less: ^4.0.0
      lightningcss: ^1.21.0
      sass: ^1.70.0
      sass-embedded: ^1.70.0
      stylus: '>=0.54.8'
      sugarss: ^5.0.0
      terser: ^5.16.0
      tsx: ^4.8.1
      yaml: ^2.4.2
    peerDependenciesMeta:
      '@types/node':
        optional: true
      jiti:
        optional: true
      less:
        optional: true
      lightningcss:
        optional: true
      sass:
        optional: true
      sass-embedded:
        optional: true
      stylus:
        optional: true
      sugarss:
        optional: true
      terser:
        optional: true
      tsx:
        optional: true
      yaml:
        optional: true

  vscode-uri@3.1.0:
    resolution: {integrity: sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==}

  vue-screen-utils@1.0.0-beta.13:
    resolution: {integrity: sha512-EJ/8TANKhFj+LefDuOvZykwMr3rrLFPLNb++lNBqPOpVigT2ActRg6icH9RFQVm4nHwlHIHSGm5OY/Clar9yIg==}
    peerDependencies:
      vue: ^3.2.0

  vue-tsc@3.1.8:
    resolution: {integrity: sha512-deKgwx6exIHeZwF601P1ktZKNF0bepaSN4jBU3AsbldPx9gylUc1JDxYppl82yxgkAgaz0Y0LCLOi+cXe9HMYA==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vue@3.5.25:
    resolution: {integrity: sha512-YLVdgv2K13WJ6n+kD5owehKtEXwdwXuj2TTyJMsO7pSeKw2bfRNZGjhB7YzrpbMYj5b5QsUebHpOqR3R3ziy/g==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

snapshots:

  '@babel/helper-string-parser@7.27.1': {}

  '@babel/helper-validator-identifier@7.28.5': {}

  '@babel/parser@7.28.5':
    dependencies:
      '@babel/types': 7.28.5

  '@babel/runtime@7.28.4': {}

  '@babel/types@7.28.5':
    dependencies:
      '@babel/helper-string-parser': 7.27.1
      '@babel/helper-validator-identifier': 7.28.5

  '@esbuild/aix-ppc64@0.27.2':
    optional: true

  '@esbuild/android-arm64@0.27.2':
    optional: true

  '@esbuild/android-arm@0.27.2':
    optional: true

  '@esbuild/android-x64@0.27.2':
    optional: true

  '@esbuild/darwin-arm64@0.27.2':
    optional: true

  '@esbuild/darwin-x64@0.27.2':
    optional: true

  '@esbuild/freebsd-arm64@0.27.2':
    optional: true

  '@esbuild/freebsd-x64@0.27.2':
    optional: true

  '@esbuild/linux-arm64@0.27.2':
    optional: true

  '@esbuild/linux-arm@0.27.2':
    optional: true

  '@esbuild/linux-ia32@0.27.2':
    optional: true

  '@esbuild/linux-loong64@0.27.2':
    optional: true

  '@esbuild/linux-mips64el@0.27.2':
    optional: true

  '@esbuild/linux-ppc64@0.27.2':
    optional: true

  '@esbuild/linux-riscv64@0.27.2':
    optional: true

  '@esbuild/linux-s390x@0.27.2':
    optional: true

  '@esbuild/linux-x64@0.27.2':
    optional: true

  '@esbuild/netbsd-arm64@0.27.2':
    optional: true

  '@esbuild/netbsd-x64@0.27.2':
    optional: true

  '@esbuild/openbsd-arm64@0.27.2':
    optional: true

  '@esbuild/openbsd-x64@0.27.2':
    optional: true

  '@esbuild/openharmony-arm64@0.27.2':
    optional: true

  '@esbuild/sunos-x64@0.27.2':
    optional: true

  '@esbuild/win32-arm64@0.27.2':
    optional: true

  '@esbuild/win32-ia32@0.27.2':
    optional: true

  '@esbuild/win32-x64@0.27.2':
    optional: true

  '@jridgewell/gen-mapping@0.3.13':
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/remapping@2.3.5':
    dependencies:
      '@jridgewell/gen-mapping': 0.3.13
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/resolve-uri@3.1.2': {}

  '@jridgewell/sourcemap-codec@1.5.5': {}

  '@jridgewell/trace-mapping@0.3.31':
    dependencies:
      '@jridgewell/resolve-uri': 3.1.2
      '@jridgewell/sourcemap-codec': 1.5.5

  '@popperjs/core@2.11.8': {}

  '@rolldown/pluginutils@1.0.0-beta.53': {}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    optional: true

  '@rollup/rollup-android-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-x64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-arm64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-x64@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-musl@4.53.5':
    optional: true

  '@rollup/rollup-openharmony-arm64@4.53.5':
    optional: true

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    optional: true

  '@tailwindcss/node@4.1.18':
    dependencies:
      '@jridgewell/remapping': 2.3.5
      enhanced-resolve: 5.18.4
      jiti: 2.6.1
      lightningcss: 1.30.2
      magic-string: 0.30.21
      source-map-js: 1.2.1
      tailwindcss: 4.1.18

  '@tailwindcss/oxide-android-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide@4.1.18':
    optionalDependencies:
      '@tailwindcss/oxide-android-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-x64': 4.1.18
      '@tailwindcss/oxide-freebsd-x64': 4.1.18
      '@tailwindcss/oxide-linux-arm-gnueabihf': 4.1.18
      '@tailwindcss/oxide-linux-arm64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-arm64-musl': 4.1.18
      '@tailwindcss/oxide-linux-x64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-x64-musl': 4.1.18
      '@tailwindcss/oxide-wasm32-wasi': 4.1.18
      '@tailwindcss/oxide-win32-arm64-msvc': 4.1.18
      '@tailwindcss/oxide-win32-x64-msvc': 4.1.18

  '@tailwindcss/vite@4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))':
    dependencies:
      '@tailwindcss/node': 4.1.18
      '@tailwindcss/oxide': 4.1.18
      tailwindcss: 4.1.18
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)

  '@types/estree@1.0.8': {}

  '@types/lodash@4.17.21': {}

  '@types/node@24.10.4':
    dependencies:
      undici-types: 7.16.0

  '@types/resize-observer-browser@0.1.11': {}

  '@vitejs/plugin-vue@6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@rolldown/pluginutils': 1.0.0-beta.53
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue: 3.5.25(typescript@5.9.3)

  '@volar/language-core@2.4.26':
    dependencies:
      '@volar/source-map': 2.4.26

  '@volar/source-map@2.4.26': {}

  '@volar/typescript@2.4.26':
    dependencies:
      '@volar/language-core': 2.4.26
      path-browserify: 1.0.1
      vscode-uri: 3.1.0

  '@vue/compiler-core@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/shared': 3.5.25
      entities: 4.5.0
      estree-walker: 2.0.2
      source-map-js: 1.2.1

  '@vue/compiler-dom@3.5.25':
    dependencies:
      '@vue/compiler-core': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/compiler-sfc@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/compiler-core': 3.5.25
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      estree-walker: 2.0.2
      magic-string: 0.30.21
      postcss: 8.5.6
      source-map-js: 1.2.1

  '@vue/compiler-ssr@3.5.25':
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/devtools-api@7.7.9':
    dependencies:
      '@vue/devtools-kit': 7.7.9

  '@vue/devtools-kit@7.7.9':
    dependencies:
      '@vue/devtools-shared': 7.7.9
      birpc: 2.9.0
      hookable: 5.5.3
      mitt: 3.0.1
      perfect-debounce: 1.0.0
      speakingurl: 14.0.1
      superjson: 2.2.6

  '@vue/devtools-shared@7.7.9':
    dependencies:
      rfdc: 1.4.1

  '@vue/language-core@3.1.8(typescript@5.9.3)':
    dependencies:
      '@volar/language-core': 2.4.26
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25
      alien-signals: 3.1.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.3
    optionalDependencies:
      typescript: 5.9.3

  '@vue/reactivity@3.5.25':
    dependencies:
      '@vue/shared': 3.5.25

  '@vue/runtime-core@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/runtime-dom@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/runtime-core': 3.5.25
      '@vue/shared': 3.5.25
      csstype: 3.2.3

  '@vue/server-renderer@3.5.25(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      vue: 3.5.25(typescript@5.9.3)

  '@vue/shared@3.5.25': {}

  '@vue/tsconfig@0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))':
    optionalDependencies:
      typescript: 5.9.3
      vue: 3.5.25(typescript@5.9.3)

  alien-signals@3.1.1: {}

  autoprefixer@10.4.23(postcss@8.5.6):
    dependencies:
      browserslist: 4.28.1
      caniuse-lite: 1.0.30001760
      fraction.js: 5.3.4
      picocolors: 1.1.1
      postcss: 8.5.6
      postcss-value-parser: 4.2.0

  baseline-browser-mapping@2.9.9: {}

  birpc@2.9.0: {}

  browserslist@4.28.1:
    dependencies:
      baseline-browser-mapping: 2.9.9
      caniuse-lite: 1.0.30001760
      electron-to-chromium: 1.5.267
      node-releases: 2.0.27
      update-browserslist-db: 1.2.3(browserslist@4.28.1)

  caniuse-lite@1.0.30001760: {}

  copy-anything@4.0.5:
    dependencies:
      is-what: 5.5.0

  csstype@3.2.3: {}

  date-fns-tz@2.0.1(date-fns@2.30.0):
    dependencies:
      date-fns: 2.30.0

  date-fns@2.30.0:
    dependencies:
      '@babel/runtime': 7.28.4

  detect-libc@2.1.2: {}

  electron-to-chromium@1.5.267: {}

  enhanced-resolve@5.18.4:
    dependencies:
      graceful-fs: 4.2.11
      tapable: 2.3.0

  entities@4.5.0: {}

  esbuild@0.27.2:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.27.2
      '@esbuild/android-arm': 0.27.2
      '@esbuild/android-arm64': 0.27.2
      '@esbuild/android-x64': 0.27.2
      '@esbuild/darwin-arm64': 0.27.2
      '@esbuild/darwin-x64': 0.27.2
      '@esbuild/freebsd-arm64': 0.27.2
      '@esbuild/freebsd-x64': 0.27.2
      '@esbuild/linux-arm': 0.27.2
      '@esbuild/linux-arm64': 0.27.2
      '@esbuild/linux-ia32': 0.27.2
      '@esbuild/linux-loong64': 0.27.2
      '@esbuild/linux-mips64el': 0.27.2
      '@esbuild/linux-ppc64': 0.27.2
      '@esbuild/linux-riscv64': 0.27.2
      '@esbuild/linux-s390x': 0.27.2
      '@esbuild/linux-x64': 0.27.2
      '@esbuild/netbsd-arm64': 0.27.2
      '@esbuild/netbsd-x64': 0.27.2
      '@esbuild/openbsd-arm64': 0.27.2
      '@esbuild/openbsd-x64': 0.27.2
      '@esbuild/openharmony-arm64': 0.27.2
      '@esbuild/sunos-x64': 0.27.2
      '@esbuild/win32-arm64': 0.27.2
      '@esbuild/win32-ia32': 0.27.2
      '@esbuild/win32-x64': 0.27.2

  escalade@3.2.0: {}

  estree-walker@2.0.2: {}

  fdir@6.5.0(picomatch@4.0.3):
    optionalDependencies:
      picomatch: 4.0.3

  fraction.js@5.3.4: {}

  fsevents@2.3.3:
    optional: true

  graceful-fs@4.2.11: {}

  hookable@5.5.3: {}

  is-what@5.5.0: {}

  jiti@2.6.1: {}

  lightningcss-android-arm64@1.30.2:
    optional: true

  lightningcss-darwin-arm64@1.30.2:
    optional: true

  lightningcss-darwin-x64@1.30.2:
    optional: true

  lightningcss-freebsd-x64@1.30.2:
    optional: true

  lightningcss-linux-arm-gnueabihf@1.30.2:
    optional: true

  lightningcss-linux-arm64-gnu@1.30.2:
    optional: true

  lightningcss-linux-arm64-musl@1.30.2:
    optional: true

  lightningcss-linux-x64-gnu@1.30.2:
    optional: true

  lightningcss-linux-x64-musl@1.30.2:
    optional: true

  lightningcss-win32-arm64-msvc@1.30.2:
    optional: true

  lightningcss-win32-x64-msvc@1.30.2:
    optional: true

  lightningcss@1.30.2:
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      lightningcss-android-arm64: 1.30.2
      lightningcss-darwin-arm64: 1.30.2
      lightningcss-darwin-x64: 1.30.2
      lightningcss-freebsd-x64: 1.30.2
      lightningcss-linux-arm-gnueabihf: 1.30.2
      lightningcss-linux-arm64-gnu: 1.30.2
      lightningcss-linux-arm64-musl: 1.30.2
      lightningcss-linux-x64-gnu: 1.30.2
      lightningcss-linux-x64-musl: 1.30.2
      lightningcss-win32-arm64-msvc: 1.30.2
      lightningcss-win32-x64-msvc: 1.30.2

  lodash@4.17.21: {}

  magic-string@0.30.21:
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5

  mitt@3.0.1: {}

  muggle-string@0.4.1: {}

  nanoid@3.3.11: {}

  node-releases@2.0.27: {}

  path-browserify@1.0.1: {}

  perfect-debounce@1.0.0: {}

  picocolors@1.1.1: {}

  picomatch@4.0.3: {}

  pinia@3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@vue/devtools-api': 7.7.9
      vue: 3.5.25(typescript@5.9.3)
    optionalDependencies:
      typescript: 5.9.3

  postcss-value-parser@4.2.0: {}

  postcss@8.5.6:
    dependencies:
      nanoid: 3.3.11
      picocolors: 1.1.1
      source-map-js: 1.2.1

  rfdc@1.4.1: {}

  rollup@4.53.5:
    dependencies:
      '@types/estree': 1.0.8
    optionalDependencies:
      '@rollup/rollup-android-arm-eabi': 4.53.5
      '@rollup/rollup-android-arm64': 4.53.5
      '@rollup/rollup-darwin-arm64': 4.53.5
      '@rollup/rollup-darwin-x64': 4.53.5
      '@rollup/rollup-freebsd-arm64': 4.53.5
      '@rollup/rollup-freebsd-x64': 4.53.5
      '@rollup/rollup-linux-arm-gnueabihf': 4.53.5
      '@rollup/rollup-linux-arm-musleabihf': 4.53.5
      '@rollup/rollup-linux-arm64-gnu': 4.53.5
      '@rollup/rollup-linux-arm64-musl': 4.53.5
      '@rollup/rollup-linux-loong64-gnu': 4.53.5
      '@rollup/rollup-linux-ppc64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-musl': 4.53.5
      '@rollup/rollup-linux-s390x-gnu': 4.53.5
      '@rollup/rollup-linux-x64-gnu': 4.53.5
      '@rollup/rollup-linux-x64-musl': 4.53.5
      '@rollup/rollup-openharmony-arm64': 4.53.5
      '@rollup/rollup-win32-arm64-msvc': 4.53.5
      '@rollup/rollup-win32-ia32-msvc': 4.53.5
      '@rollup/rollup-win32-x64-gnu': 4.53.5
      '@rollup/rollup-win32-x64-msvc': 4.53.5
      fsevents: 2.3.3

  source-map-js@1.2.1: {}

  speakingurl@14.0.1: {}

  superjson@2.2.6:
    dependencies:
      copy-anything: 4.0.5

  tailwindcss@4.1.18: {}

  tapable@2.3.0: {}

  tinyglobby@0.2.15:
    dependencies:
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3

  typescript@5.9.3: {}

  undici-types@7.16.0: {}

  update-browserslist-db@1.2.3(browserslist@4.28.1):
    dependencies:
      browserslist: 4.28.1
      escalade: 3.2.0
      picocolors: 1.1.1

  v-calendar@3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@popperjs/core': 2.11.8
      '@types/lodash': 4.17.21
      '@types/resize-observer-browser': 0.1.11
      date-fns: 2.30.0
      date-fns-tz: 2.0.1(date-fns@2.30.0)
      lodash: 4.17.21
      vue: 3.5.25(typescript@5.9.3)
      vue-screen-utils: 1.0.0-beta.13(vue@3.5.25(typescript@5.9.3))

  vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2):
    dependencies:
      esbuild: 0.27.2
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3
      postcss: 8.5.6
      rollup: 4.53.5
      tinyglobby: 0.2.15
    optionalDependencies:
      '@types/node': 24.10.4
      fsevents: 2.3.3
      jiti: 2.6.1
      lightningcss: 1.30.2

  vscode-uri@3.1.0: {}

  vue-screen-utils@1.0.0-beta.13(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      vue: 3.5.25(typescript@5.9.3)

  vue-tsc@3.1.8(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.26
      '@vue/language-core': 3.1.8(typescript@5.9.3)
      typescript: 5.9.3

  vue@3.5.25(typescript@5.9.3):
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-sfc': 3.5.25
      '@vue/runtime-dom': 3.5.25
      '@vue/server-renderer': 3.5.25(vue@3.5.25(typescript@5.9.3))
      '@vue/shared': 3.5.25
    optionalDependencies:
      typescript: 5.9.3

```

## pnpm-workspace.yaml

```yaml
packages:
  - 'frontend'
  - 'backend'

```


`````

## backend/san_dir.txt

```text
node_modules
.git
dist
```

## backend/san_file.txt

```text
project_export.md
*.svg
*.log
```

## backend/store/schema.go

```go
package store

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/glebarez/sqlite" // Driver Pure Go (Important !)
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// =============================================================================
// DEFINITION DES TYPES (ENUMS)
// =============================================================================
const (
	TypeEvent      = "EVENT"
	TypeEnvie      = "ENVIE"
	TypeResolution = "RESOLUTION"
	TypeObligation = "OBLIGATION"

	StatusTodo  = "TODO"
	StatusDoing = "DOING"
	StatusDone  = "DONE"
)

// =============================================================================
// MODELES DE DONNEES (STRUCTS)
// =============================================================================

type Item struct {
	gorm.Model
	Title       string     `json:"title"`
	Description string     `json:"description"`
	Type        string     `json:"type"`
	Status      string     `json:"status" gorm:"default:'TODO'"`
	Date        *time.Time `json:"date"`
	IsRecurring bool       `json:"is_recurring"`
	SubTasks    []SubTask  `json:"sub_tasks" gorm:"constraint:OnUpdate:CASCADE,OnDelete:CASCADE;"`

	// Nouveaux champs V1
	Priority    string     `json:"priority"`     // LOW, MEDIUM, HIGH
	PlannedEnd  *time.Time `json:"planned_end"`  // Pour les durées
	ActualStart *time.Time `json:"actual_start"` // Quand j'ai cliqué sur "Doing"
	ActualEnd   *time.Time `json:"actual_end"`   // Quand j'ai cliqué sur "Done"

	// Pour le Drag & Drop (Ordre dans l'inbox)
	SortOrder int `json:"sort_order"`
}

type SubTask struct {
	gorm.Model
	ItemID  uint   `json:"item_id"`
	Content string `json:"content"`
	IsDone  bool   `json:"is_done"`
}

// =============================================================================
// LOGIQUE BASE DE DONNEES
// =============================================================================

func InitDB(dbPath string) *gorm.DB {
	// 1. SECURITE : Création automatique du dossier parent
	// Si dbPath est "/data/klaro.db", on s'assure que "/data" existe.
	dir := filepath.Dir(dbPath)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		// On crée le dossier avec les permissions 755 (rwxr-xr-x)
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Fatalf("❌ Erreur critique: Impossible de créer le dossier DB '%s': %v", dir, err)
		}
	}

	// 2. Connexion GORM
	// On ajoute un paramètre pragmatique pour éviter certains verrous SQLite (_busy_timeout)
	db, err := gorm.Open(sqlite.Open(dbPath+"?_pragma=busy_timeout(5000)"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Warn),
	})
	if err != nil {
		log.Fatal("❌ Echec connexion DB:", err)
	}

	// 3. Migration
	err = db.AutoMigrate(&Item{}, &SubTask{})
	if err != nil {
		log.Fatal("❌ Echec migration DB:", err)
	}

	log.Printf("✅ Base de données prête : %s", dbPath)
	return db
}

```

## backend/tmp/build-errors.log

```text
exit status 1exit status 1exit status 1exit status 1exit status 1exit status 1
```

## backend/tmp/main

> Fichier binaire non inclus (8823244 octets)

## documentation/RELEASE_PROCESS.md

````markdown
# 📘 RELEASE_PROCESS.md

# 🚀 Canevas de Déploiement & Release — Klaro

Ce document décrit le cycle de vie de l’application.

**Philosophie :** Docker Hub reste propre. **Seules les versions taguées (releases)** génèrent une image Docker et un déploiement.

---

## 1. 🏗️ Architecture CI/CD

Le pipeline est divisé pour garantir la qualité avant la production.

| Étape              | Trigger                 | Exécuté par              | Action                                                                  |
| ------------------ | ----------------------- | ------------------------ | ----------------------------------------------------------------------- |
| 1. CI (Quality)    | Push `main` / PR        | GitHub Runners           | Linter, tests unitaires, build check. **Aucune image n’est poussée.**   |
| 2. Build & Release | **Tag `v*` uniquement** | GitHub Runners           | Construit l’image, **push** sur Docker Hub, crée la **Release GitHub**. |
| 3. Deploy          | Succès du Build         | Self-Hosted Runner (K3s) | Le cluster tire la nouvelle image taguée et met à jour les pods.        |

---

## 2. 🛡️ Discipline de Branche

⚠️ **Note importante :** le plan GitHub actuel ne permet pas le blocage technique des pushs.
Nous appliquons donc une protection par discipline.

* Interdiction de push directement sur `main` sans avoir testé localement (`make dev`).
* La branche `main` doit toujours être dans un état stable (**deployable**).
* Toute nouvelle fonctionnalité devrait idéalement être développée dans une branche `feat/ma-feature`, puis mergée dans `main`.

---

## 3. 🛠️ Flux de Développement (Features)

Pour toute modification (**hors hotfix critique**), on passe par une branche dédiée.

### 3.1 Création de la branche

```bash
# Partir de main à jour
git checkout main
git pull

# Créer la branche (Convention: feat/..., fix/..., chore/...)
git checkout -b feat/ma-nouvelle-feature
```

### 3.2 Développement & Push

```bash
# ... Coding ...
git add .
git commit -m "feat: Description de la feature"

# Premier push (configure le lien avec l'origine)
git push -u origin feat/ma-nouvelle-feature
```

### 3.3 Pull Request & Merge (via GitHub CLI)

```bash
# Créer la Pull Request vers main
# (Si c'est la première fois, utilise 'gh repo set-default saasMsDGH/klaro')
gh pr create --title "feat: Ma Feature" --body "Description des changements..."

# Une fois la CI (Quality) passée au vert :
# Merger en mode 'Squash' (1 seul commit sur main) et supprimer la branche distante
gh pr merge --squash --delete-branch
```

### 3.4 Retour sur main

```bash
git checkout main
git pull
# Ton local est maintenant à jour avec ta feature intégrée
```

---

## 4. 🔄 Procédure de Release (Mise en Prod)

C’est **l’unique méthode** pour mettre à jour la production.

**Source de vérité :** `package.json`.

### Pré-requis

* Être sur la branche `main` à jour.
* Avoir un arbre de travail propre (`git status` clean).
* Les tests locaux passent.

### Commandes à exécuter

```bash
# 1. Incrémenter la version (Patch: 0.0.1 -> 0.0.2)
# Cette commande met à jour package.json SANS créer de tag git tout de suite
npm version patch --no-git-tag-version

# 2. Vérifier la version
grep version package.json

# 3. Commiter le changement de version
git add package.json
git commit -m "chore: Bump version to $(jq -r .version package.json)"
git push origin main

# 4. Créer et pousser le tag (c’est le DÉCLENCHEUR du déploiement)
# Le tag DOIT correspondre à la version du package.json avec un 'v' devant
VERSION=$(jq -r .version package.json)
git tag v$VERSION
git push origin v$VERSION
```

---

## 5. 🔍 Vérifications Post-Déploiement

Une fois le workflow **« Build & Release (Tag Only) »** terminé sur GitHub.

* **GitHub Releases :** la release `v0.0.x` est créée avec le changelog auto-généré.
* **Docker Hub :** le tag `spadmdck/klaro:0.0.x` est présent. *(Le tag `latest` est aussi mis à jour.)*

### Cluster K3s

```bash
# Vérifier que le déploiement utilise la nouvelle version
kubectl describe deployment klaro -n apps | grep Image

# Résultat attendu : spadmdck/klaro:0.0.x
```

---

## 6. ⚠️ Dépannage

| Symptôme                               | Cause probable                                                       | Solution                                                              |
| -------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Le pipeline ne démarre pas             | Push sans tag.                                                       | Vérifier que `git push --tags` a bien été fait.                       |
| Job Build échoue : “Tag mismatch”      | Le tag Git (`v1.0.1`) ne correspond pas au `package.json` (`1.0.0`). | Corriger `package.json`, refaire un commit, supprimer/recréer le tag. |
| Erreur SQLite “Binary was compiled...” | Problème de driver CGO.                                              | Vérifier que `go.mod` utilise `github.com/glebarez/sqlite`.           |
| Docker Push “Denied”                   | Secrets manquants.                                                   | Vérifier les secrets `DOCKER_*` dans l’Organisation GitHub.           |

---

## 7. 🔐 Gestion des Secrets & Infra

* **Organisation :** `saasMsDGH`
* **Portée des secrets :** Organisation (accessibles à tous les futurs projets SaaS)
* **Runner :** Self-Hosted dans le cluster K3s (Namespace `actions-runner-system`)

````

## frontend/.gitignore

```text
# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
dist
dist-ssr
*.local

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

```

## frontend/.vscode/extensions.json

```json
{
  "recommendations": ["Vue.volar"]
}

```

## frontend/README.md

```markdown
# Vue 3 + TypeScript + Vite

This template should help get you started developing with Vue 3 and TypeScript in Vite. The template uses Vue 3 `<script setup>` SFCs, check out the [script setup docs](https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup) to learn more.

Learn more about the recommended Project Setup and IDE Support in the [Vue Docs TypeScript Guide](https://vuejs.org/guide/typescript/overview.html#project-setup).

```

## frontend/index.html

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Klaro</title>
    <link href="https://fonts.googleapis.com/css2?family=Spline+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
    <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>

```

## frontend/package.json

```json
{
  "name": "frontend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@popperjs/core": "^2.11.8",
    "@tailwindcss/vite": "^4.1.18",
    "maplibre-gl": "^5.15.0",
    "pinia": "^3.0.4",
    "v-calendar": "^3.1.2",
    "vue": "^3.5.24"
  },
  "devDependencies": {
    "@types/node": "^24.10.1",
    "@vitejs/plugin-vue": "^6.0.1",
    "@vue/tsconfig": "^0.8.1",
    "autoprefixer": "^10.4.23",
    "postcss": "^8.5.6",
    "tailwindcss": "^4.1.18",
    "typescript": "~5.9.3",
    "vite": "^7.2.4",
    "vue-tsc": "^3.1.4"
  }
}

```

## frontend/pnpm-lock.yaml

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      vue:
        specifier: ^3.5.24
        version: 3.5.25(typescript@5.9.3)
    devDependencies:
      '@types/node':
        specifier: ^24.10.1
        version: 24.10.4
      '@vitejs/plugin-vue':
        specifier: ^6.0.1
        version: 6.0.3(vite@7.3.0(@types/node@24.10.4))(vue@3.5.25(typescript@5.9.3))
      '@vue/tsconfig':
        specifier: ^0.8.1
        version: 0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      typescript:
        specifier: ~5.9.3
        version: 5.9.3
      vite:
        specifier: ^7.2.4
        version: 7.3.0(@types/node@24.10.4)
      vue-tsc:
        specifier: ^3.1.4
        version: 3.1.8(typescript@5.9.3)

packages:

  '@babel/helper-string-parser@7.27.1':
    resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
    engines: {node: '>=6.9.0'}

  '@babel/helper-validator-identifier@7.28.5':
    resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
    engines: {node: '>=6.9.0'}

  '@babel/parser@7.28.5':
    resolution: {integrity: sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  '@babel/types@7.28.5':
    resolution: {integrity: sha512-qQ5m48eI/MFLQ5PxQj4PFaprjyCTLI37ElWMmNs0K8Lk3dVeOdNpB3ks8jc7yM5CDmVC73eMVk/trk3fgmrUpA==}
    engines: {node: '>=6.9.0'}

  '@esbuild/aix-ppc64@0.27.2':
    resolution: {integrity: sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.27.2':
    resolution: {integrity: sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.27.2':
    resolution: {integrity: sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.27.2':
    resolution: {integrity: sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.27.2':
    resolution: {integrity: sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.27.2':
    resolution: {integrity: sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.27.2':
    resolution: {integrity: sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.27.2':
    resolution: {integrity: sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.27.2':
    resolution: {integrity: sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.27.2':
    resolution: {integrity: sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.27.2':
    resolution: {integrity: sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.27.2':
    resolution: {integrity: sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.27.2':
    resolution: {integrity: sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.27.2':
    resolution: {integrity: sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.27.2':
    resolution: {integrity: sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.27.2':
    resolution: {integrity: sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.27.2':
    resolution: {integrity: sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.27.2':
    resolution: {integrity: sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.27.2':
    resolution: {integrity: sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.27.2':
    resolution: {integrity: sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.27.2':
    resolution: {integrity: sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.27.2':
    resolution: {integrity: sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.27.2':
    resolution: {integrity: sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.27.2':
    resolution: {integrity: sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.27.2':
    resolution: {integrity: sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.27.2':
    resolution: {integrity: sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/sourcemap-codec@1.5.5':
    resolution: {integrity: sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==}

  '@rolldown/pluginutils@1.0.0-beta.53':
    resolution: {integrity: sha512-vENRlFU4YbrwVqNDZ7fLvy+JR1CRkyr01jhSiDpE1u6py3OMzQfztQU2jxykW3ALNxO4kSlqIDeYyD0Y9RcQeQ==}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    resolution: {integrity: sha512-iDGS/h7D8t7tvZ1t6+WPK04KD0MwzLZrG0se1hzBjSi5fyxlsiggoJHwh18PCFNn7tG43OWb6pdZ6Y+rMlmyNQ==}
    cpu: [arm]
    os: [android]

  '@rollup/rollup-android-arm64@4.53.5':
    resolution: {integrity: sha512-wrSAViWvZHBMMlWk6EJhvg8/rjxzyEhEdgfMMjREHEq11EtJ6IP6yfcCH57YAEca2Oe3FNCE9DSTgU70EIGmVw==}
    cpu: [arm64]
    os: [android]

  '@rollup/rollup-darwin-arm64@4.53.5':
    resolution: {integrity: sha512-S87zZPBmRO6u1YXQLwpveZm4JfPpAa6oHBX7/ghSiGH3rz/KDgAu1rKdGutV+WUI6tKDMbaBJomhnT30Y2t4VQ==}
    cpu: [arm64]
    os: [darwin]

  '@rollup/rollup-darwin-x64@4.53.5':
    resolution: {integrity: sha512-YTbnsAaHo6VrAczISxgpTva8EkfQus0VPEVJCEaboHtZRIb6h6j0BNxRBOwnDciFTZLDPW5r+ZBmhL/+YpTZgA==}
    cpu: [x64]
    os: [darwin]

  '@rollup/rollup-freebsd-arm64@4.53.5':
    resolution: {integrity: sha512-1T8eY2J8rKJWzaznV7zedfdhD1BqVs1iqILhmHDq/bqCUZsrMt+j8VCTHhP0vdfbHK3e1IQ7VYx3jlKqwlf+vw==}
    cpu: [arm64]
    os: [freebsd]

  '@rollup/rollup-freebsd-x64@4.53.5':
    resolution: {integrity: sha512-sHTiuXyBJApxRn+VFMaw1U+Qsz4kcNlxQ742snICYPrY+DDL8/ZbaC4DVIB7vgZmp3jiDaKA0WpBdP0aqPJoBQ==}
    cpu: [x64]
    os: [freebsd]

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    resolution: {integrity: sha512-dV3T9MyAf0w8zPVLVBptVlzaXxka6xg1f16VAQmjg+4KMSTWDvhimI/Y6mp8oHwNrmnmVl9XxJ/w/mO4uIQONA==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    resolution: {integrity: sha512-wIGYC1x/hyjP+KAu9+ewDI+fi5XSNiUi9Bvg6KGAh2TsNMA3tSEs+Sh6jJ/r4BV/bx/CyWu2ue9kDnIdRyafcQ==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    resolution: {integrity: sha512-Y+qVA0D9d0y2FRNiG9oM3Hut/DgODZbU9I8pLLPwAsU0tUKZ49cyV1tzmB/qRbSzGvY8lpgGkJuMyuhH7Ma+Vg==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    resolution: {integrity: sha512-juaC4bEgJsyFVfqhtGLz8mbopaWD+WeSOYr5E16y+1of6KQjc0BpwZLuxkClqY1i8sco+MdyoXPNiCkQou09+g==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    resolution: {integrity: sha512-rIEC0hZ17A42iXtHX+EPJVL/CakHo+tT7W0pbzdAGuWOt2jxDFh7A/lRhsNHBcqL4T36+UiAgwO8pbmn3dE8wA==}
    cpu: [loong64]
    os: [linux]

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    resolution: {integrity: sha512-T7l409NhUE552RcAOcmJHj3xyZ2h7vMWzcwQI0hvn5tqHh3oSoclf9WgTl+0QqffWFG8MEVZZP1/OBglKZx52Q==}
    cpu: [ppc64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    resolution: {integrity: sha512-7OK5/GhxbnrMcxIFoYfhV/TkknarkYC1hqUw1wU2xUN3TVRLNT5FmBv4KkheSG2xZ6IEbRAhTooTV2+R5Tk0lQ==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    resolution: {integrity: sha512-GwuDBE/PsXaTa76lO5eLJTyr2k8QkPipAyOrs4V/KJufHCZBJ495VCGJol35grx9xryk4V+2zd3Ri+3v7NPh+w==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    resolution: {integrity: sha512-IAE1Ziyr1qNfnmiQLHBURAD+eh/zH1pIeJjeShleII7Vj8kyEm2PF77o+lf3WTHDpNJcu4IXJxNO0Zluro8bOw==}
    cpu: [s390x]
    os: [linux]

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    resolution: {integrity: sha512-Pg6E+oP7GvZ4XwgRJBuSXZjcqpIW3yCBhK4BcsANvb47qMvAbCjR6E+1a/U2WXz1JJxp9/4Dno3/iSJLcm5auw==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.53.5':
    resolution: {integrity: sha512-txGtluxDKTxaMDzUduGP0wdfng24y1rygUMnmlUJ88fzCCULCLn7oE5kb2+tRB+MWq1QDZT6ObT5RrR8HFRKqg==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-openharmony-arm64@4.53.5':
    resolution: {integrity: sha512-3DFiLPnTxiOQV993fMc+KO8zXHTcIjgaInrqlG8zDp1TlhYl6WgrOHuJkJQ6M8zHEcntSJsUp1XFZSY8C1DYbg==}
    cpu: [arm64]
    os: [openharmony]

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    resolution: {integrity: sha512-nggc/wPpNTgjGg75hu+Q/3i32R00Lq1B6N1DO7MCU340MRKL3WZJMjA9U4K4gzy3dkZPXm9E1Nc81FItBVGRlA==}
    cpu: [arm64]
    os: [win32]

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    resolution: {integrity: sha512-U/54pTbdQpPLBdEzCT6NBCFAfSZMvmjr0twhnD9f4EIvlm9wy3jjQ38yQj1AGznrNO65EWQMgm/QUjuIVrYF9w==}
    cpu: [ia32]
    os: [win32]

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    resolution: {integrity: sha512-2NqKgZSuLH9SXBBV2dWNRCZmocgSOx8OJSdpRaEcRlIfX8YrKxUT6z0F1NpvDVhOsl190UFTRh2F2WDWWCYp3A==}
    cpu: [x64]
    os: [win32]

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    resolution: {integrity: sha512-JRpZUhCfhZ4keB5v0fe02gQJy05GqboPOaxvjugW04RLSYYoB/9t2lx2u/tMs/Na/1NXfY8QYjgRljRpN+MjTQ==}
    cpu: [x64]
    os: [win32]

  '@types/estree@1.0.8':
    resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}

  '@types/node@24.10.4':
    resolution: {integrity: sha512-vnDVpYPMzs4wunl27jHrfmwojOGKya0xyM3sH+UE5iv5uPS6vX7UIoh6m+vQc5LGBq52HBKPIn/zcSZVzeDEZg==}

  '@vitejs/plugin-vue@6.0.3':
    resolution: {integrity: sha512-TlGPkLFLVOY3T7fZrwdvKpjprR3s4fxRln0ORDo1VQ7HHyxJwTlrjKU3kpVWTlaAjIEuCTokmjkZnr8Tpc925w==}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0
      vue: ^3.2.25

  '@volar/language-core@2.4.26':
    resolution: {integrity: sha512-hH0SMitMxnB43OZpyF1IFPS9bgb2I3bpCh76m2WEK7BE0A0EzpYsRp0CCH2xNKshr7kacU5TQBLYn4zj7CG60A==}

  '@volar/source-map@2.4.26':
    resolution: {integrity: sha512-JJw0Tt/kSFsIRmgTQF4JSt81AUSI1aEye5Zl65EeZ8H35JHnTvFGmpDOBn5iOxd48fyGE+ZvZBp5FcgAy/1Qhw==}

  '@volar/typescript@2.4.26':
    resolution: {integrity: sha512-N87ecLD48Sp6zV9zID/5yuS1+5foj0DfuYGdQ6KHj/IbKvyKv1zNX6VCmnKYwtmHadEO6mFc2EKISiu3RDPAvA==}

  '@vue/compiler-core@3.5.25':
    resolution: {integrity: sha512-vay5/oQJdsNHmliWoZfHPoVZZRmnSWhug0BYT34njkYTPqClh3DNWLkZNJBVSjsNMrg0CCrBfoKkjZQPM/QVUw==}

  '@vue/compiler-dom@3.5.25':
    resolution: {integrity: sha512-4We0OAcMZsKgYoGlMjzYvaoErltdFI2/25wqanuTu+S4gismOTRTBPi4IASOjxWdzIwrYSjnqONfKvuqkXzE2Q==}

  '@vue/compiler-sfc@3.5.25':
    resolution: {integrity: sha512-PUgKp2rn8fFsI++lF2sO7gwO2d9Yj57Utr5yEsDf3GNaQcowCLKL7sf+LvVFvtJDXUp/03+dC6f2+LCv5aK1ag==}

  '@vue/compiler-ssr@3.5.25':
    resolution: {integrity: sha512-ritPSKLBcParnsKYi+GNtbdbrIE1mtuFEJ4U1sWeuOMlIziK5GtOL85t5RhsNy4uWIXPgk+OUdpnXiTdzn8o3A==}

  '@vue/language-core@3.1.8':
    resolution: {integrity: sha512-PfwAW7BLopqaJbneChNL6cUOTL3GL+0l8paYP5shhgY5toBNidWnMXWM+qDwL7MC9+zDtzCF2enT8r6VPu64iw==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  '@vue/reactivity@3.5.25':
    resolution: {integrity: sha512-5xfAypCQepv4Jog1U4zn8cZIcbKKFka3AgWHEFQeK65OW+Ys4XybP6z2kKgws4YB43KGpqp5D/K3go2UPPunLA==}

  '@vue/runtime-core@3.5.25':
    resolution: {integrity: sha512-Z751v203YWwYzy460bzsYQISDfPjHTl+6Zzwo/a3CsAf+0ccEjQ8c+0CdX1WsumRTHeywvyUFtW6KvNukT/smA==}

  '@vue/runtime-dom@3.5.25':
    resolution: {integrity: sha512-a4WrkYFbb19i9pjkz38zJBg8wa/rboNERq3+hRRb0dHiJh13c+6kAbgqCPfMaJ2gg4weWD3APZswASOfmKwamA==}

  '@vue/server-renderer@3.5.25':
    resolution: {integrity: sha512-UJaXR54vMG61i8XNIzTSf2Q7MOqZHpp8+x3XLGtE3+fL+nQd+k7O5+X3D/uWrnQXOdMw5VPih+Uremcw+u1woQ==}
    peerDependencies:
      vue: 3.5.25

  '@vue/shared@3.5.25':
    resolution: {integrity: sha512-AbOPdQQnAnzs58H2FrrDxYj/TJfmeS2jdfEEhgiKINy+bnOANmVizIEgq1r+C5zsbs6l1CCQxtcj71rwNQ4jWg==}

  '@vue/tsconfig@0.8.1':
    resolution: {integrity: sha512-aK7feIWPXFSUhsCP9PFqPyFOcz4ENkb8hZ2pneL6m2UjCkccvaOhC/5KCKluuBufvp2KzkbdA2W2pk20vLzu3g==}
    peerDependencies:
      typescript: 5.x
      vue: ^3.4.0
    peerDependenciesMeta:
      typescript:
        optional: true
      vue:
        optional: true

  alien-signals@3.1.1:
    resolution: {integrity: sha512-ogkIWbVrLwKtHY6oOAXaYkAxP+cTH7V5FZ5+Tm4NZFd8VDZ6uNMDrfzqctTZ42eTMCSR3ne3otpcxmqSnFfPYA==}

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  entities@4.5.0:
    resolution: {integrity: sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==}
    engines: {node: '>=0.12'}

  esbuild@0.27.2:
    resolution: {integrity: sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==}
    engines: {node: '>=18'}
    hasBin: true

  estree-walker@2.0.2:
    resolution: {integrity: sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==}

  fdir@6.5.0:
    resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
    engines: {node: '>=12.0.0'}
    peerDependencies:
      picomatch: ^3 || ^4
    peerDependenciesMeta:
      picomatch:
        optional: true

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  magic-string@0.30.21:
    resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}

  muggle-string@0.4.1:
    resolution: {integrity: sha512-VNTrAak/KhO2i8dqqnqnAHOa3cYBwXEZe9h+D5h/1ZqFSTEFHdM65lR7RoIqq3tBBYavsOXV84NoHXZ0AkPyqQ==}

  nanoid@3.3.11:
    resolution: {integrity: sha512-N8SpfPUnUp1bK+PMYW8qSWdl9U+wwNWI4QKxOYDy9JAro3WMX7p2OeVRF9v+347pnakNevPmiHhNmZ2HbFA76w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  path-browserify@1.0.1:
    resolution: {integrity: sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  picomatch@4.0.3:
    resolution: {integrity: sha512-5gTmgEY/sqK6gFXLIsQNH19lWb4ebPDLA4SdLP7dsWkIXHWlG66oPuVvXSGFPppYZz8ZDZq0dYYrbHfBCVUb1Q==}
    engines: {node: '>=12'}

  postcss@8.5.6:
    resolution: {integrity: sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==}
    engines: {node: ^10 || ^12 || >=14}

  rollup@4.53.5:
    resolution: {integrity: sha512-iTNAbFSlRpcHeeWu73ywU/8KuU/LZmNCSxp6fjQkJBD3ivUb8tpDrXhIxEzA05HlYMEwmtaUnb3RP+YNv162OQ==}
    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
    hasBin: true

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  tinyglobby@0.2.15:
    resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
    engines: {node: '>=12.0.0'}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.16.0:
    resolution: {integrity: sha512-Zz+aZWSj8LE6zoxD+xrjh4VfkIG8Ya6LvYkZqtUQGJPZjYl53ypCaUwWqo7eI0x66KBGeRo+mlBEkMSeSZ38Nw==}

  vite@7.3.0:
    resolution: {integrity: sha512-dZwN5L1VlUBewiP6H9s2+B3e3Jg96D0vzN+Ry73sOefebhYr9f94wwkMNN/9ouoU8pV1BqA1d1zGk8928cx0rg==}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true
    peerDependencies:
      '@types/node': ^20.19.0 || >=22.12.0
      jiti: '>=1.21.0'
      less: ^4.0.0
      lightningcss: ^1.21.0
      sass: ^1.70.0
      sass-embedded: ^1.70.0
      stylus: '>=0.54.8'
      sugarss: ^5.0.0
      terser: ^5.16.0
      tsx: ^4.8.1
      yaml: ^2.4.2
    peerDependenciesMeta:
      '@types/node':
        optional: true
      jiti:
        optional: true
      less:
        optional: true
      lightningcss:
        optional: true
      sass:
        optional: true
      sass-embedded:
        optional: true
      stylus:
        optional: true
      sugarss:
        optional: true
      terser:
        optional: true
      tsx:
        optional: true
      yaml:
        optional: true

  vscode-uri@3.1.0:
    resolution: {integrity: sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==}

  vue-tsc@3.1.8:
    resolution: {integrity: sha512-deKgwx6exIHeZwF601P1ktZKNF0bepaSN4jBU3AsbldPx9gylUc1JDxYppl82yxgkAgaz0Y0LCLOi+cXe9HMYA==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vue@3.5.25:
    resolution: {integrity: sha512-YLVdgv2K13WJ6n+kD5owehKtEXwdwXuj2TTyJMsO7pSeKw2bfRNZGjhB7YzrpbMYj5b5QsUebHpOqR3R3ziy/g==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

snapshots:

  '@babel/helper-string-parser@7.27.1': {}

  '@babel/helper-validator-identifier@7.28.5': {}

  '@babel/parser@7.28.5':
    dependencies:
      '@babel/types': 7.28.5

  '@babel/types@7.28.5':
    dependencies:
      '@babel/helper-string-parser': 7.27.1
      '@babel/helper-validator-identifier': 7.28.5

  '@esbuild/aix-ppc64@0.27.2':
    optional: true

  '@esbuild/android-arm64@0.27.2':
    optional: true

  '@esbuild/android-arm@0.27.2':
    optional: true

  '@esbuild/android-x64@0.27.2':
    optional: true

  '@esbuild/darwin-arm64@0.27.2':
    optional: true

  '@esbuild/darwin-x64@0.27.2':
    optional: true

  '@esbuild/freebsd-arm64@0.27.2':
    optional: true

  '@esbuild/freebsd-x64@0.27.2':
    optional: true

  '@esbuild/linux-arm64@0.27.2':
    optional: true

  '@esbuild/linux-arm@0.27.2':
    optional: true

  '@esbuild/linux-ia32@0.27.2':
    optional: true

  '@esbuild/linux-loong64@0.27.2':
    optional: true

  '@esbuild/linux-mips64el@0.27.2':
    optional: true

  '@esbuild/linux-ppc64@0.27.2':
    optional: true

  '@esbuild/linux-riscv64@0.27.2':
    optional: true

  '@esbuild/linux-s390x@0.27.2':
    optional: true

  '@esbuild/linux-x64@0.27.2':
    optional: true

  '@esbuild/netbsd-arm64@0.27.2':
    optional: true

  '@esbuild/netbsd-x64@0.27.2':
    optional: true

  '@esbuild/openbsd-arm64@0.27.2':
    optional: true

  '@esbuild/openbsd-x64@0.27.2':
    optional: true

  '@esbuild/openharmony-arm64@0.27.2':
    optional: true

  '@esbuild/sunos-x64@0.27.2':
    optional: true

  '@esbuild/win32-arm64@0.27.2':
    optional: true

  '@esbuild/win32-ia32@0.27.2':
    optional: true

  '@esbuild/win32-x64@0.27.2':
    optional: true

  '@jridgewell/sourcemap-codec@1.5.5': {}

  '@rolldown/pluginutils@1.0.0-beta.53': {}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    optional: true

  '@rollup/rollup-android-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-x64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-arm64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-x64@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-musl@4.53.5':
    optional: true

  '@rollup/rollup-openharmony-arm64@4.53.5':
    optional: true

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    optional: true

  '@types/estree@1.0.8': {}

  '@types/node@24.10.4':
    dependencies:
      undici-types: 7.16.0

  '@vitejs/plugin-vue@6.0.3(vite@7.3.0(@types/node@24.10.4))(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@rolldown/pluginutils': 1.0.0-beta.53
      vite: 7.3.0(@types/node@24.10.4)
      vue: 3.5.25(typescript@5.9.3)

  '@volar/language-core@2.4.26':
    dependencies:
      '@volar/source-map': 2.4.26

  '@volar/source-map@2.4.26': {}

  '@volar/typescript@2.4.26':
    dependencies:
      '@volar/language-core': 2.4.26
      path-browserify: 1.0.1
      vscode-uri: 3.1.0

  '@vue/compiler-core@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/shared': 3.5.25
      entities: 4.5.0
      estree-walker: 2.0.2
      source-map-js: 1.2.1

  '@vue/compiler-dom@3.5.25':
    dependencies:
      '@vue/compiler-core': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/compiler-sfc@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/compiler-core': 3.5.25
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      estree-walker: 2.0.2
      magic-string: 0.30.21
      postcss: 8.5.6
      source-map-js: 1.2.1

  '@vue/compiler-ssr@3.5.25':
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/language-core@3.1.8(typescript@5.9.3)':
    dependencies:
      '@volar/language-core': 2.4.26
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25
      alien-signals: 3.1.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.3
    optionalDependencies:
      typescript: 5.9.3

  '@vue/reactivity@3.5.25':
    dependencies:
      '@vue/shared': 3.5.25

  '@vue/runtime-core@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/runtime-dom@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/runtime-core': 3.5.25
      '@vue/shared': 3.5.25
      csstype: 3.2.3

  '@vue/server-renderer@3.5.25(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      vue: 3.5.25(typescript@5.9.3)

  '@vue/shared@3.5.25': {}

  '@vue/tsconfig@0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))':
    optionalDependencies:
      typescript: 5.9.3
      vue: 3.5.25(typescript@5.9.3)

  alien-signals@3.1.1: {}

  csstype@3.2.3: {}

  entities@4.5.0: {}

  esbuild@0.27.2:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.27.2
      '@esbuild/android-arm': 0.27.2
      '@esbuild/android-arm64': 0.27.2
      '@esbuild/android-x64': 0.27.2
      '@esbuild/darwin-arm64': 0.27.2
      '@esbuild/darwin-x64': 0.27.2
      '@esbuild/freebsd-arm64': 0.27.2
      '@esbuild/freebsd-x64': 0.27.2
      '@esbuild/linux-arm': 0.27.2
      '@esbuild/linux-arm64': 0.27.2
      '@esbuild/linux-ia32': 0.27.2
      '@esbuild/linux-loong64': 0.27.2
      '@esbuild/linux-mips64el': 0.27.2
      '@esbuild/linux-ppc64': 0.27.2
      '@esbuild/linux-riscv64': 0.27.2
      '@esbuild/linux-s390x': 0.27.2
      '@esbuild/linux-x64': 0.27.2
      '@esbuild/netbsd-arm64': 0.27.2
      '@esbuild/netbsd-x64': 0.27.2
      '@esbuild/openbsd-arm64': 0.27.2
      '@esbuild/openbsd-x64': 0.27.2
      '@esbuild/openharmony-arm64': 0.27.2
      '@esbuild/sunos-x64': 0.27.2
      '@esbuild/win32-arm64': 0.27.2
      '@esbuild/win32-ia32': 0.27.2
      '@esbuild/win32-x64': 0.27.2

  estree-walker@2.0.2: {}

  fdir@6.5.0(picomatch@4.0.3):
    optionalDependencies:
      picomatch: 4.0.3

  fsevents@2.3.3:
    optional: true

  magic-string@0.30.21:
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5

  muggle-string@0.4.1: {}

  nanoid@3.3.11: {}

  path-browserify@1.0.1: {}

  picocolors@1.1.1: {}

  picomatch@4.0.3: {}

  postcss@8.5.6:
    dependencies:
      nanoid: 3.3.11
      picocolors: 1.1.1
      source-map-js: 1.2.1

  rollup@4.53.5:
    dependencies:
      '@types/estree': 1.0.8
    optionalDependencies:
      '@rollup/rollup-android-arm-eabi': 4.53.5
      '@rollup/rollup-android-arm64': 4.53.5
      '@rollup/rollup-darwin-arm64': 4.53.5
      '@rollup/rollup-darwin-x64': 4.53.5
      '@rollup/rollup-freebsd-arm64': 4.53.5
      '@rollup/rollup-freebsd-x64': 4.53.5
      '@rollup/rollup-linux-arm-gnueabihf': 4.53.5
      '@rollup/rollup-linux-arm-musleabihf': 4.53.5
      '@rollup/rollup-linux-arm64-gnu': 4.53.5
      '@rollup/rollup-linux-arm64-musl': 4.53.5
      '@rollup/rollup-linux-loong64-gnu': 4.53.5
      '@rollup/rollup-linux-ppc64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-musl': 4.53.5
      '@rollup/rollup-linux-s390x-gnu': 4.53.5
      '@rollup/rollup-linux-x64-gnu': 4.53.5
      '@rollup/rollup-linux-x64-musl': 4.53.5
      '@rollup/rollup-openharmony-arm64': 4.53.5
      '@rollup/rollup-win32-arm64-msvc': 4.53.5
      '@rollup/rollup-win32-ia32-msvc': 4.53.5
      '@rollup/rollup-win32-x64-gnu': 4.53.5
      '@rollup/rollup-win32-x64-msvc': 4.53.5
      fsevents: 2.3.3

  source-map-js@1.2.1: {}

  tinyglobby@0.2.15:
    dependencies:
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3

  typescript@5.9.3: {}

  undici-types@7.16.0: {}

  vite@7.3.0(@types/node@24.10.4):
    dependencies:
      esbuild: 0.27.2
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3
      postcss: 8.5.6
      rollup: 4.53.5
      tinyglobby: 0.2.15
    optionalDependencies:
      '@types/node': 24.10.4
      fsevents: 2.3.3

  vscode-uri@3.1.0: {}

  vue-tsc@3.1.8(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.26
      '@vue/language-core': 3.1.8(typescript@5.9.3)
      typescript: 5.9.3

  vue@3.5.25(typescript@5.9.3):
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-sfc': 3.5.25
      '@vue/runtime-dom': 3.5.25
      '@vue/server-renderer': 3.5.25(vue@3.5.25(typescript@5.9.3))
      '@vue/shared': 3.5.25
    optionalDependencies:
      typescript: 5.9.3

```

## frontend/public/vite.svg

```text
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" class="iconify iconify--logos" width="31.88" height="32" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 257"><defs><linearGradient id="IconifyId1813088fe1fbc01fb466" x1="-.828%" x2="57.636%" y1="7.652%" y2="78.411%"><stop offset="0%" stop-color="#41D1FF"></stop><stop offset="100%" stop-color="#BD34FE"></stop></linearGradient><linearGradient id="IconifyId1813088fe1fbc01fb467" x1="43.376%" x2="50.316%" y1="2.242%" y2="89.03%"><stop offset="0%" stop-color="#FFEA83"></stop><stop offset="8.333%" stop-color="#FFDD35"></stop><stop offset="100%" stop-color="#FFA800"></stop></linearGradient></defs><path fill="url(#IconifyId1813088fe1fbc01fb466)" d="M255.153 37.938L134.897 252.976c-2.483 4.44-8.862 4.466-11.382.048L.875 37.958c-2.746-4.814 1.371-10.646 6.827-9.67l120.385 21.517a6.537 6.537 0 0 0 2.322-.004l117.867-21.483c5.438-.991 9.574 4.796 6.877 9.62Z"></path><path fill="url(#IconifyId1813088fe1fbc01fb467)" d="M185.432.063L96.44 17.501a3.268 3.268 0 0 0-2.634 3.014l-5.474 92.456a3.268 3.268 0 0 0 3.997 3.378l24.777-5.718c2.318-.535 4.413 1.507 3.936 3.838l-7.361 36.047c-.495 2.426 1.782 4.5 4.151 3.78l15.304-4.649c2.372-.72 4.652 1.36 4.15 3.788l-11.698 56.621c-.732 3.542 3.979 5.473 5.943 2.437l1.313-2.028l72.516-144.72c1.215-2.423-.88-5.186-3.54-4.672l-25.505 4.922c-2.396.462-4.435-1.77-3.759-4.114l16.646-57.705c.677-2.35-1.37-4.583-3.769-4.113Z"></path></svg>
```

## frontend/src/App.vue

```text
<script setup>
import { ref, onMounted } from 'vue';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const codeInsee = ref('75101'); // Exemple : Paris 1er
const mapContainer = ref(null);
let map;

const searchCadastre = async () => {
  const response = await fetch(`http://localhost:8080/api/cadastre?code_insee=${codeInsee.value}`);
  const data = await response.json();

  if (map.getSource('parcelles')) {
    map.getSource('parcelles').setData(data);
  } else {
    map.addSource('parcelles', { type: 'geojson', data });
    map.addLayer({
      id: 'parcelles-layer',
      type: 'fill',
      source: 'parcelles',
      paint: {
        'circle-color': '#3b82f6',
        'fill-color': '#3b82f6',
        'fill-opacity': 0.4,
        'fill-outline-color': '#1d4ed8'
      }
    });
  }
};

onMounted(() => {
  map = new maplibregl.Map({
    container: mapContainer.value,
    style: 'https://demotiles.maplibre.org/style.json', // À remplacer par un style IGN ou OSM
    center: [2.3522, 48.8566],
    zoom: 12
  });
});
</script>

<template>
  <div class="h-screen flex flex-col font-sans text-gray-900">
    <header class="bg-indigo-700 text-white p-4 shadow-lg flex justify-between items-center">
      <h1 class="text-xl font-bold">Portail Cadastral v1.0</h1>
      <div class="flex space-x-2">
        <input v-model="codeInsee" class="px-3 py-1 rounded text-black" placeholder="Code INSEE (ex: 75101)" />
        <button @click="searchCadastre" class="bg-green-500 hover:bg-green-600 px-4 py-1 rounded transition">Charger</button>
      </div>
    </header>

    <main class="flex-1 relative">
      <div ref="mapContainer" class="absolute inset-0"></div>
      
      <div class="absolute top-4 left-4 bg-white p-4 rounded-lg shadow-md max-w-xs z-10 border border-gray-200">
        <h2 class="font-semibold mb-2 text-indigo-800">Informations Foncières</h2>
        <p class="text-sm text-gray-600">Saisissez un code INSEE pour visualiser les limites parcellaires à jour.</p>
      </div>
    </main>
  </div>
</template>

<style>
/* Reset simple pour occuper tout l'écran */
body { margin: 0; }
</style>
```

## frontend/src/assets/vue.svg

```text
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" aria-hidden="true" role="img" class="iconify iconify--logos" width="37.07" height="36" preserveAspectRatio="xMidYMid meet" viewBox="0 0 256 198"><path fill="#41B883" d="M204.8 0H256L128 220.8L0 0h97.92L128 51.2L157.44 0h47.36Z"></path><path fill="#41B883" d="m0 0l128 220.8L256 0h-51.2L128 132.48L50.56 0H0Z"></path><path fill="#35495E" d="M50.56 0L128 133.12L204.8 0h-47.36L128 51.2L97.92 0H50.56Z"></path></svg>
```

## frontend/src/components/HelloWorld.vue

```text
<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ msg: string }>()

const count = ref(0)
</script>

<template>
  <h1>{{ msg }}</h1>

  <div class="card">
    <button type="button" @click="count++">count is {{ count }}</button>
    <p>
      Edit
      <code>components/HelloWorld.vue</code> to test HMR
    </p>
  </div>

  <p>
    Check out
    <a href="https://vuejs.org/guide/quick-start.html#local" target="_blank"
      >create-vue</a
    >, the official Vue + Vite starter
  </p>
  <p>
    Learn more about IDE Support for Vue in the
    <a
      href="https://vuejs.org/guide/scaling-up/tooling.html#ide-support"
      target="_blank"
      >Vue Docs Scaling up Guide</a
    >.
  </p>
  <p class="read-the-docs">Click on the Vite and Vue logos to learn more</p>
</template>

<style scoped>
.read-the-docs {
  color: #888;
}
</style>

```

## frontend/src/main.ts

```typescript
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './style.css' // Ton CSS Tailwind v4

// Import de V-Calendar et son CSS
import VCalendar from 'v-calendar';
import 'v-calendar/style.css';

const app = createApp(App)

// 1. Activation du Store (Pinia)
app.use(createPinia())

// 2. Activation du Calendrier (Setup global)
app.use(VCalendar, {
  componentPrefix: 'vc', // On utilisera <vc-calendar /> dans les templates
});

app.mount('#app')
```

## frontend/src/stores/kadastro.ts

```typescript
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

const API_BASE = import.meta.env.PROD ? '' : 'http://localhost:8080';

// --- TYPES EXISTANTS (ITEMS/EVENTS) ---
export interface SubTask {
  ID: number;
  item_id: number;
  content: string;
  is_done: boolean;
}

export interface Item {
  ID: number;
  title: string;
  description?: string;
  type: 'EVENT' | 'ENVIE' | 'RESOLUTION' | 'OBLIGATION';
  status: 'TODO' | 'DOING' | 'DONE';
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  date?: string;        
  sub_tasks: SubTask[];
}

// --- NOUVEAUX TYPES (EPICS/PROJETS) ---
export interface EpicTask {
  ID: number;
  epic_id: number;
  title: string;
  is_done: boolean;
}

export interface Epic {
  ID: number;
  title: string;
  description?: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  start_date: string; // ISO String
  end_date: string;   // ISO String
  tasks: EpicTask[];
}

export const useKlaroStore = defineStore('klaro', () => {
  // STATES
  const items = ref<Item[]>([])
  const epics = ref<Epic[]>([])
  const loading = ref(false)

  // ===========================================================================
  // GETTERS (COMPUTED)
  // ===========================================================================

  // --- ITEMS (Legacy/Event) ---
  const calendarItems = computed(() => items.value.filter((i): i is Item & { date: string } => !!i.date))
  const backlogItems = computed(() => items.value.filter(i => !i.date && i.status !== 'DONE'))
  
  const calendarAttributes = computed(() => {
    return calendarItems.value.map(item => {
      let color = 'gray';
      switch(item.type) {
        case 'EVENT': color = 'blue'; break;
        case 'OBLIGATION': color = 'red'; break;
        case 'RESOLUTION': color = 'purple'; break;
        case 'ENVIE': color = 'yellow'; break;
      }
      return {
        key: `item-${item.ID}`,
        dot: true,
        dates: new Date(item.date),
        customData: item,
        popover: { label: item.title },
        highlight: { color: color, fillMode: 'light' }
      }
    })
  })

  // --- EPICS (Nouveau) ---
  // Transforme les épopées en objets riches pour l'affichage (Barres de temps)
  const epicRanges = computed(() => {
    return epics.value.map(epic => {
      const total = epic.tasks?.length || 0;
      const done = epic.tasks?.filter(t => t.is_done).length || 0;
      const progress = total > 0 ? Math.round((done / total) * 100) : 0;

      return {
        ...epic,
        progress,
        // Helper pour savoir si l'épopée est "en retard" (date fin passée et pas 100%)
        isOverdue: new Date(epic.end_date) < new Date() && progress < 100,
        startDateObj: new Date(epic.start_date),
        endDateObj: new Date(epic.end_date)
      }
    }).sort((a, b) => a.startDateObj.getTime() - b.startDateObj.getTime());
  });

  // Focus du jour mélangé (Items importants + Epics en cours)
  const focusItems = computed(() => {
    const today = new Date().toISOString().split('T')[0];
    
    // 1. Items du jour ou haute priorité
    const criticalItems = items.value.filter(i => 
      (i.priority === 'HIGH' && i.status !== 'TODO') || 
      (i.date && i.date.startsWith(today!))
    );

    return criticalItems.slice(0, 5);
  });

  const completionRate = computed(() => {
    if (items.value.length === 0) return 0;
    const done = items.value.filter(i => i.status === 'DONE').length;
    return Math.round((done / items.value.length) * 100);
  });

  // ===========================================================================
  // ACTIONS
  // ===========================================================================

  async function fetchAll() {
    loading.value = true;
    try {
        await Promise.all([fetchItems(), fetchEpics()]);
    } finally {
        loading.value = false;
    }
  }

  // --- ITEMS ACTIONS ---
  async function fetchItems() {
    try {
      const res = await fetch(`${API_BASE}/api/items`);
      if (res.ok) items.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createItem(newItem: Partial<Item>) {
    try {
      const res = await fetch(`${API_BASE}/api/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...newItem, priority: newItem.priority || 'MEDIUM' })
      });
      const created = await res.json();
      items.value.push(created);
    } catch (e) { console.error("Erreur création item", e); }
  }

  async function updateItem(item: Item) {
    const idx = items.value.findIndex(i => i.ID === item.ID);
    if (idx !== -1) items.value[idx] = item;
    // TODO: Connecter le PUT backend quand implémenté
  }

  async function toggleSubTask(itemId: number, taskId: number) {
    // Optimistic
    const item = items.value.find(i => i.ID === itemId);
    if (item) {
        const task = item.sub_tasks.find(t => t.ID === taskId);
        if (task) task.is_done = !task.is_done;
    }
    // API
    try {
      await fetch(`${API_BASE}/api/subtasks/${taskId}/toggle`, { method: 'PATCH' });
    } catch (e) { console.error(e); }
  }

  // --- EPICS ACTIONS (Nouveau) ---

  async function fetchEpics() {
    try {
      const res = await fetch(`${API_BASE}/api/epics`);
      if (res.ok) epics.value = await res.json();
    } catch (e) { console.error(e); }
  }

  async function createEpic(epic: Partial<Epic>) {
    try {
      const res = await fetch(`${API_BASE}/api/epics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(epic)
      });
      const created = await res.json();
      // On s'assure que le tableau tasks existe
      created.tasks = []; 
      epics.value.push(created);
      return created;
    } catch (e) { console.error("Erreur création epic", e); }
  }

  async function addEpicTask(epicId: number, title: string) {
    try {
      const res = await fetch(`${API_BASE}/api/epics/${epicId}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title })
      });
      const newTask = await res.json();
      
      // Update local
      const epic = epics.value.find(e => e.ID === epicId);
      if (epic) epic.tasks.push(newTask);
      
      return newTask;
    } catch (e) { console.error("Erreur ajout task epic", e); }
  }

  async function toggleEpicTask(taskId: number) {
    // Optimistic Update (Recherche imbriquée)
    let found = false;
    for (const epic of epics.value) {
        const task = epic.tasks?.find(t => t.ID === taskId);
        if (task) {
            task.is_done = !task.is_done;
            found = true;
            break;
        }
    }
    
    if (found) {
        try {
            await fetch(`${API_BASE}/api/tasks/${taskId}/toggle`, { method: 'PATCH' });
        } catch(e) { console.error(e); }
    }
  }

  return { 
    // State
    items, 
    epics,
    loading, 
    
    // Getters
    calendarItems, 
    backlogItems, 
    focusItems, 
    completionRate,
    calendarAttributes,
    epicRanges, // <-- Le nouveau getter puissant pour le calendrier
    
    // Actions
    fetchAll,
    fetchItems, 
    createItem, 
    updateItem,
    toggleSubTask,
    // Actions Epics
    fetchEpics,
    createEpic,
    addEpicTask,
    toggleEpicTask
  }
});
```

## frontend/src/style.css

```css
@import "tailwindcss";

@theme {
  /* --- TYPOGRAPHIE --- */
  --font-display: "Spline Sans", sans-serif;
  --font-sans: "Spline Sans", sans-serif;

  /* --- COULEURS SEMANTIQUES --- */
  /* Ces variables changent de valeur selon le mode (voir plus bas) */
  
  /* Primaire (Le Jaune Neon) */
  --color-primary: #f9f506;
  --color-primary-hover: #e0dc05;
  --color-primary-content: #18181b;

  /* Arrière-plans */
  --color-bg-app: var(--bg-app);
  --color-bg-surface: var(--bg-surface);
  --color-bg-surface-hover: var(--bg-surface-hover);
  --color-bg-element: var(--bg-element);

  /* Bordures */
  --color-border-main: var(--border-main);
  --color-border-subtle: var(--border-subtle);

  /* Texte */
  --color-text-main: var(--text-main);
  --color-text-muted: var(--text-muted);
  --color-text-inverse: var(--text-inverse);

  /* Status (Pastels) */
  --color-tag-blue-bg: var(--tag-blue-bg);
  --color-tag-blue-text: var(--tag-blue-text);
  --color-tag-yellow-bg: var(--tag-yellow-bg);
  --color-tag-yellow-text: var(--tag-yellow-text);
  --color-tag-red-bg: var(--tag-red-bg);
  --color-tag-red-text: var(--tag-red-text);
  --color-tag-purple-bg: var(--tag-purple-bg);
  --color-tag-purple-text: var(--tag-purple-text);

  /* Ombres */
  --shadow-soft: 0 4px 6px -1px rgba(0, 0, 0, 0.05), 0 2px 4px -1px rgba(0, 0, 0, 0.03);
  --shadow-glow: 0 0 20px rgba(249, 245, 6, 0.15);
}

/* --- VALEURS DES VARIABLES --- */
:root {
  /* MODE CLAIR (Par défaut) */
  --bg-app: #f8fafc;        /* Slate 50 */
  --bg-surface: #ffffff;    /* White */
  --bg-surface-hover: #f1f5f9;
  --bg-element: #f1f5f9;    /* Slate 100 */
  
  --border-main: #e2e8f0;   /* Slate 200 */
  --border-subtle: #f1f5f9;
  
  --text-main: #0f172a;     /* Slate 900 */
  --text-muted: #64748b;    /* Slate 500 */
  --text-inverse: #ffffff;

  /* Tags Clair */
  --tag-blue-bg: #e0f2fe; --tag-blue-text: #0369a1;
  --tag-yellow-bg: #fef9c3; --tag-yellow-text: #854d0e;
  --tag-red-bg: #fee2e2; --tag-red-text: #991b1b;
  --tag-purple-bg: #f3e8ff; --tag-purple-text: #6b21a8;
}

:root.dark {
  /* MODE SOMBRE */
  --bg-app: #020617;        /* Slate 950 (Plus profond) */
  --bg-surface: #0f172a;    /* Slate 900 */
  --bg-surface-hover: #1e293b;
  --bg-element: #1e293b;    /* Slate 800 */
  
  --border-main: #1e293b;   /* Slate 800 */
  --border-subtle: #334155;
  
  --text-main: #f8fafc;     /* Slate 50 */
  --text-muted: #94a3b8;    /* Slate 400 */
  --text-inverse: #0f172a;

  /* Tags Sombre (Plus transparents) */
  --tag-blue-bg: rgba(56, 189, 248, 0.15); --tag-blue-text: #7dd3fc;
  --tag-yellow-bg: rgba(253, 224, 71, 0.15); --tag-yellow-text: #fde047;
  --tag-red-bg: rgba(248, 113, 113, 0.15); --tag-red-text: #fca5a5;
  --tag-purple-bg: rgba(192, 132, 252, 0.15); --tag-purple-text: #d8b4fe;
}

/* Base Reset */
html, body {
  background-color: var(--color-bg-app);
  color: var(--color-text-main);
  font-family: var(--font-display);
  height: 100%;
  overflow: hidden;
  /* Transition douce lors du changement de thème */
  transition: background-color 0.3s ease, color 0.3s ease, border-color 0.3s ease;
}

#app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* Material Icons Fix */
.material-symbols-outlined {
  font-variation-settings: 'FILL' 1, 'wght' 400, 'GRAD' 0, 'opsz' 24;
  user-select: none; 
}

/* Scrollbar */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--color-border-main); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }
```

## frontend/tsconfig.app.json

```json
{
  "extends": "@vue/tsconfig/tsconfig.dom.json",
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "types": ["vite/client"],

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.vue"]
}

```

## frontend/tsconfig.json

```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}

```

## frontend/tsconfig.node.json

```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "types": ["node"],
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedSideEffectImports": true
  },
  "include": ["vite.config.ts"]
}

```

## frontend/vite.config.ts

```typescript
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(),tailwindcss()],
})

```

## k8s/deployment.yaml

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: klaro
  namespace: apps
  labels:
    app: klaro
spec:
  replicas: 1 # Tu pourras augmenter ça plus tard
  selector:
    matchLabels:
      app: klaro
  template:
    metadata:
      labels:
        app: klaro
    spec:
      securityContext:
        runAsUser: 10001
        runAsGroup: 10001
        fsGroup: 10001 # <--- K3s fera un chown automatique du volume vers ce groupe
      containers:
        - name: klaro
          # Le tag sera remplacé dynamiquement par la CI/CD
          image: DOCKER_IMAGE_PLACEHOLDER 
          ports:
            - containerPort: 8080 # Le port exposé par ton main.go
          env:
            - name: PORT
              value: "8080"
            - name: DB_PATH
              value: "/data/klaro.db"
          volumeMounts:
            - name: data
              mountPath: /data
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: klaro-pvc
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: klaro-pvc
  namespace: apps
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: local-path # Le stockage par défaut de K3s
  resources:
    requests:
      storage: 1Gi
```

## k8s/ingress.yaml

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: klaro
  namespace: apps
  annotations:
    # Intégration avec ton Traefik existant
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    traefik.ingress.kubernetes.io/router.tls.certresolver: "le" 
spec:
  ingressClassName: traefik
  rules:
    - host: klaro.dgsynthex.online 
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: klaro
                port:
                  number: 80
```

## k8s/service.yaml

```yaml
apiVersion: v1
kind: Service
metadata:
  name: klaro
  namespace: apps
spec:
  selector:
    app: klaro
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
```

## package.json

```json
{
  "name": "klaro",
  "version": "0.2.1",
  "description": "",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "packageManager": "pnpm@10.21.0"
}

```

## plan

```text
📦 Feature A : feat/front-store-epics (La Plomberie)
Objectif : Connecter le Frontend à la nouvelle API Backend sans toucher à l'UI.

Contenu :

Mise à jour des types TypeScript dans stores/klaro.ts (Ajout interfaces Epic, EpicTask).

Ajout des actions Pinia : fetchEpics, createEpic, addEpicTask, toggleEpicTask.

Adaptation des getters pour préparer les données du calendrier.

##############################################################
##############################################################
##############################################################
Prompt:
"Mets à jour le fichier frontend/src/stores/klaro.ts. Je veux intégrer la nouvelle logique Backend Epic (Projets sur la durée) tout en gardant Item (Events ponctuels).

Ajoute les interfaces Epic et EpicTask correspondant aux structs Go.

Ajoute un state epics: ref<Epic[]>([]).

Ajoute les actions fetchEpics, createEpic (POST /api/epics), createEpicTask (POST /api/epics/{id}/tasks) et toggleEpicTask.

Crée un getter calendarRanges qui transforme les Epics en objets utilisables pour l'affichage (avec start, end, couleur, % de progression)."
##############################################################
##############################################################
##############################################################



🎨 Feature B : feat/ui-creation-flow (L'Entrée de données)
Objectif : Permettre à l'utilisateur de choisir entre créer un "Event" (Item simple) ou une "Épopée" (Projet long).

Contenu :

Modification de CreateModal.vue.

Ajout d'un système d'onglets : "Tâche Rapide" (Item) vs "Épopée" (Epic).

Formulaire Épopée : Titre, Description, Date Début et Date Fin obligatoires, Priorité.

Pas de sous-tâches à la création de l'épopée (on crée le contenant d'abord).

Prompt
##############################################################
##############################################################
##############################################################
"Modifie frontend/src/components/CreateModal.vue. Je veux séparer la création en deux modes via des onglets en haut de la modale :

Mode 'Event' (L'existant) : Pour les items simples, ponctuels (Date unique ou Backlog).

Mode 'Épopée' (Nouveau) : Pour les projets longs. Champs Épopée : Titre, Description, Priorité (Low/Med/High), Date de Début et Date de Fin (Obligatoires). Le bouton 'Créer' doit appeler la bonne action du store (createItem ou createEpic) selon l'onglet actif."

##############################################################
##############################################################
##############################################################



📅 Feature C : feat/ui-calendar-epics (La Visualisation)
Objectif : Afficher les Épopées comme des barres continues sur le calendrier (timeline) et gérer leurs tâches.

Contenu :

Vue Mois : Afficher des barres colorées qui traversent les cases des jours (style Gantt simplifié).

Vue Semaine : Afficher une section "Projets en cours" en haut de la grille horaire (comme les "All day events" de Google Calendar).

Détail : Créer EpicDetailModal.vue pour voir l'avancement, ajouter des tâches à l'épopée et les cocher.

Prompt
##############################################################
##############################################################
##############################################################
"Mets à jour frontend/src/App.vue pour afficher les Épopées. Dans la Vue Mois (Grille) :

En plus des items ponctuels (points/textes), affiche les Épopées sous forme de barres horizontales colorées.

Ces barres doivent visuellement commencer à start_date et finir à end_date.

Si une épopée traverse plusieurs semaines, gère l'affichage pour qu'elle apparaisse sur les lignes concernées.

Au clic sur une barre d'épopée, ouvre une nouvelle modale EpicDetailModal (à créer) qui permet d'ajouter/cocher des tâches spécifiques à cette épopée."

##############################################################
##############################################################
##############################################################
```

## pnpm-lock.yaml

```yaml
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  frontend:
    dependencies:
      '@popperjs/core':
        specifier: ^2.11.8
        version: 2.11.8
      '@tailwindcss/vite':
        specifier: ^4.1.18
        version: 4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))
      maplibre-gl:
        specifier: ^5.15.0
        version: 5.15.0
      pinia:
        specifier: ^3.0.4
        version: 3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      v-calendar:
        specifier: ^3.1.2
        version: 3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3))
      vue:
        specifier: ^3.5.24
        version: 3.5.25(typescript@5.9.3)
    devDependencies:
      '@types/node':
        specifier: ^24.10.1
        version: 24.10.4
      '@vitejs/plugin-vue':
        specifier: ^6.0.1
        version: 6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))
      '@vue/tsconfig':
        specifier: ^0.8.1
        version: 0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))
      autoprefixer:
        specifier: ^10.4.23
        version: 10.4.23(postcss@8.5.6)
      postcss:
        specifier: ^8.5.6
        version: 8.5.6
      tailwindcss:
        specifier: ^4.1.18
        version: 4.1.18
      typescript:
        specifier: ~5.9.3
        version: 5.9.3
      vite:
        specifier: ^7.2.4
        version: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue-tsc:
        specifier: ^3.1.4
        version: 3.1.8(typescript@5.9.3)

packages:

  '@babel/helper-string-parser@7.27.1':
    resolution: {integrity: sha512-qMlSxKbpRlAridDExk92nSobyDdpPijUq2DW6oDnUqd0iOGxmQjyqhMIihI9+zv4LPyZdRje2cavWPbCbWm3eA==}
    engines: {node: '>=6.9.0'}

  '@babel/helper-validator-identifier@7.28.5':
    resolution: {integrity: sha512-qSs4ifwzKJSV39ucNjsvc6WVHs6b7S03sOh2OcHF9UHfVPqWWALUsNUVzhSBiItjRZoLHx7nIarVjqKVusUZ1Q==}
    engines: {node: '>=6.9.0'}

  '@babel/parser@7.28.5':
    resolution: {integrity: sha512-KKBU1VGYR7ORr3At5HAtUQ+TV3SzRCXmA/8OdDZiLDBIZxVyzXuztPjfLd3BV1PRAQGCMWWSHYhL0F8d5uHBDQ==}
    engines: {node: '>=6.0.0'}
    hasBin: true

  '@babel/runtime@7.28.4':
    resolution: {integrity: sha512-Q/N6JNWvIvPnLDvjlE1OUBLPQHH6l3CltCEsHIujp45zQUSSh8K+gHnaEX45yAT1nyngnINhvWtzN+Nb9D8RAQ==}
    engines: {node: '>=6.9.0'}

  '@babel/types@7.28.5':
    resolution: {integrity: sha512-qQ5m48eI/MFLQ5PxQj4PFaprjyCTLI37ElWMmNs0K8Lk3dVeOdNpB3ks8jc7yM5CDmVC73eMVk/trk3fgmrUpA==}
    engines: {node: '>=6.9.0'}

  '@esbuild/aix-ppc64@0.27.2':
    resolution: {integrity: sha512-GZMB+a0mOMZs4MpDbj8RJp4cw+w1WV5NYD6xzgvzUJ5Ek2jerwfO2eADyI6ExDSUED+1X8aMbegahsJi+8mgpw==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [aix]

  '@esbuild/android-arm64@0.27.2':
    resolution: {integrity: sha512-pvz8ZZ7ot/RBphf8fv60ljmaoydPU12VuXHImtAs0XhLLw+EXBi2BLe3OYSBslR4rryHvweW5gmkKFwTiFy6KA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [android]

  '@esbuild/android-arm@0.27.2':
    resolution: {integrity: sha512-DVNI8jlPa7Ujbr1yjU2PfUSRtAUZPG9I1RwW4F4xFB1Imiu2on0ADiI/c3td+KmDtVKNbi+nffGDQMfcIMkwIA==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [android]

  '@esbuild/android-x64@0.27.2':
    resolution: {integrity: sha512-z8Ank4Byh4TJJOh4wpz8g2vDy75zFL0TlZlkUkEwYXuPSgX8yzep596n6mT7905kA9uHZsf/o2OJZubl2l3M7A==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [android]

  '@esbuild/darwin-arm64@0.27.2':
    resolution: {integrity: sha512-davCD2Zc80nzDVRwXTcQP/28fiJbcOwvdolL0sOiOsbwBa72kegmVU0Wrh1MYrbuCL98Omp5dVhQFWRKR2ZAlg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [darwin]

  '@esbuild/darwin-x64@0.27.2':
    resolution: {integrity: sha512-ZxtijOmlQCBWGwbVmwOF/UCzuGIbUkqB1faQRf5akQmxRJ1ujusWsb3CVfk/9iZKr2L5SMU5wPBi1UWbvL+VQA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [darwin]

  '@esbuild/freebsd-arm64@0.27.2':
    resolution: {integrity: sha512-lS/9CN+rgqQ9czogxlMcBMGd+l8Q3Nj1MFQwBZJyoEKI50XGxwuzznYdwcav6lpOGv5BqaZXqvBSiB/kJ5op+g==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [freebsd]

  '@esbuild/freebsd-x64@0.27.2':
    resolution: {integrity: sha512-tAfqtNYb4YgPnJlEFu4c212HYjQWSO/w/h/lQaBK7RbwGIkBOuNKQI9tqWzx7Wtp7bTPaGC6MJvWI608P3wXYA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [freebsd]

  '@esbuild/linux-arm64@0.27.2':
    resolution: {integrity: sha512-hYxN8pr66NsCCiRFkHUAsxylNOcAQaxSSkHMMjcpx0si13t1LHFphxJZUiGwojB1a/Hd5OiPIqDdXONia6bhTw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [linux]

  '@esbuild/linux-arm@0.27.2':
    resolution: {integrity: sha512-vWfq4GaIMP9AIe4yj1ZUW18RDhx6EPQKjwe7n8BbIecFtCQG4CfHGaHuh7fdfq+y3LIA2vGS/o9ZBGVxIDi9hw==}
    engines: {node: '>=18'}
    cpu: [arm]
    os: [linux]

  '@esbuild/linux-ia32@0.27.2':
    resolution: {integrity: sha512-MJt5BRRSScPDwG2hLelYhAAKh9imjHK5+NE/tvnRLbIqUWa+0E9N4WNMjmp/kXXPHZGqPLxggwVhz7QP8CTR8w==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [linux]

  '@esbuild/linux-loong64@0.27.2':
    resolution: {integrity: sha512-lugyF1atnAT463aO6KPshVCJK5NgRnU4yb3FUumyVz+cGvZbontBgzeGFO1nF+dPueHD367a2ZXe1NtUkAjOtg==}
    engines: {node: '>=18'}
    cpu: [loong64]
    os: [linux]

  '@esbuild/linux-mips64el@0.27.2':
    resolution: {integrity: sha512-nlP2I6ArEBewvJ2gjrrkESEZkB5mIoaTswuqNFRv/WYd+ATtUpe9Y09RnJvgvdag7he0OWgEZWhviS1OTOKixw==}
    engines: {node: '>=18'}
    cpu: [mips64el]
    os: [linux]

  '@esbuild/linux-ppc64@0.27.2':
    resolution: {integrity: sha512-C92gnpey7tUQONqg1n6dKVbx3vphKtTHJaNG2Ok9lGwbZil6DrfyecMsp9CrmXGQJmZ7iiVXvvZH6Ml5hL6XdQ==}
    engines: {node: '>=18'}
    cpu: [ppc64]
    os: [linux]

  '@esbuild/linux-riscv64@0.27.2':
    resolution: {integrity: sha512-B5BOmojNtUyN8AXlK0QJyvjEZkWwy/FKvakkTDCziX95AowLZKR6aCDhG7LeF7uMCXEJqwa8Bejz5LTPYm8AvA==}
    engines: {node: '>=18'}
    cpu: [riscv64]
    os: [linux]

  '@esbuild/linux-s390x@0.27.2':
    resolution: {integrity: sha512-p4bm9+wsPwup5Z8f4EpfN63qNagQ47Ua2znaqGH6bqLlmJ4bx97Y9JdqxgGZ6Y8xVTixUnEkoKSHcpRlDnNr5w==}
    engines: {node: '>=18'}
    cpu: [s390x]
    os: [linux]

  '@esbuild/linux-x64@0.27.2':
    resolution: {integrity: sha512-uwp2Tip5aPmH+NRUwTcfLb+W32WXjpFejTIOWZFw/v7/KnpCDKG66u4DLcurQpiYTiYwQ9B7KOeMJvLCu/OvbA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [linux]

  '@esbuild/netbsd-arm64@0.27.2':
    resolution: {integrity: sha512-Kj6DiBlwXrPsCRDeRvGAUb/LNrBASrfqAIok+xB0LxK8CHqxZ037viF13ugfsIpePH93mX7xfJp97cyDuTZ3cw==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [netbsd]

  '@esbuild/netbsd-x64@0.27.2':
    resolution: {integrity: sha512-HwGDZ0VLVBY3Y+Nw0JexZy9o/nUAWq9MlV7cahpaXKW6TOzfVno3y3/M8Ga8u8Yr7GldLOov27xiCnqRZf0tCA==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [netbsd]

  '@esbuild/openbsd-arm64@0.27.2':
    resolution: {integrity: sha512-DNIHH2BPQ5551A7oSHD0CKbwIA/Ox7+78/AWkbS5QoRzaqlev2uFayfSxq68EkonB+IKjiuxBFoV8ESJy8bOHA==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openbsd]

  '@esbuild/openbsd-x64@0.27.2':
    resolution: {integrity: sha512-/it7w9Nb7+0KFIzjalNJVR5bOzA9Vay+yIPLVHfIQYG/j+j9VTH84aNB8ExGKPU4AzfaEvN9/V4HV+F+vo8OEg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [openbsd]

  '@esbuild/openharmony-arm64@0.27.2':
    resolution: {integrity: sha512-LRBbCmiU51IXfeXk59csuX/aSaToeG7w48nMwA6049Y4J4+VbWALAuXcs+qcD04rHDuSCSRKdmY63sruDS5qag==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [openharmony]

  '@esbuild/sunos-x64@0.27.2':
    resolution: {integrity: sha512-kMtx1yqJHTmqaqHPAzKCAkDaKsffmXkPHThSfRwZGyuqyIeBvf08KSsYXl+abf5HDAPMJIPnbBfXvP2ZC2TfHg==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [sunos]

  '@esbuild/win32-arm64@0.27.2':
    resolution: {integrity: sha512-Yaf78O/B3Kkh+nKABUF++bvJv5Ijoy9AN1ww904rOXZFLWVc5OLOfL56W+C8F9xn5JQZa3UX6m+IktJnIb1Jjg==}
    engines: {node: '>=18'}
    cpu: [arm64]
    os: [win32]

  '@esbuild/win32-ia32@0.27.2':
    resolution: {integrity: sha512-Iuws0kxo4yusk7sw70Xa2E2imZU5HoixzxfGCdxwBdhiDgt9vX9VUCBhqcwY7/uh//78A1hMkkROMJq9l27oLQ==}
    engines: {node: '>=18'}
    cpu: [ia32]
    os: [win32]

  '@esbuild/win32-x64@0.27.2':
    resolution: {integrity: sha512-sRdU18mcKf7F+YgheI/zGf5alZatMUTKj/jNS6l744f9u3WFu4v7twcUI9vu4mknF4Y9aDlblIie0IM+5xxaqQ==}
    engines: {node: '>=18'}
    cpu: [x64]
    os: [win32]

  '@jridgewell/gen-mapping@0.3.13':
    resolution: {integrity: sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==}

  '@jridgewell/remapping@2.3.5':
    resolution: {integrity: sha512-LI9u/+laYG4Ds1TDKSJW2YPrIlcVYOwi2fUC6xB43lueCjgxV4lffOCZCtYFiH6TNOX+tQKXx97T4IKHbhyHEQ==}

  '@jridgewell/resolve-uri@3.1.2':
    resolution: {integrity: sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==}
    engines: {node: '>=6.0.0'}

  '@jridgewell/sourcemap-codec@1.5.5':
    resolution: {integrity: sha512-cYQ9310grqxueWbl+WuIUIaiUaDcj7WOq5fVhEljNVgRfOUhY9fy2zTvfoqWsnebh8Sl70VScFbICvJnLKB0Og==}

  '@jridgewell/trace-mapping@0.3.31':
    resolution: {integrity: sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==}

  '@mapbox/geojson-rewind@0.5.2':
    resolution: {integrity: sha512-tJaT+RbYGJYStt7wI3cq4Nl4SXxG8W7JDG5DMJu97V25RnbNg3QtQtf+KD+VLjNpWKYsRvXDNmNrBgEETr1ifA==}
    hasBin: true

  '@mapbox/jsonlint-lines-primitives@2.0.2':
    resolution: {integrity: sha512-rY0o9A5ECsTQRVhv7tL/OyDpGAoUB4tTvLiW1DSzQGq4bvTPhNw1VpSNjDJc5GFZ2XuyOtSWSVN05qOtcD71qQ==}
    engines: {node: '>= 0.6'}

  '@mapbox/point-geometry@1.1.0':
    resolution: {integrity: sha512-YGcBz1cg4ATXDCM/71L9xveh4dynfGmcLDqufR+nQQy3fKwsAZsWd/x4621/6uJaeB9mwOHE6hPeDgXz9uViUQ==}

  '@mapbox/tiny-sdf@2.0.7':
    resolution: {integrity: sha512-25gQLQMcpivjOSA40g3gO6qgiFPDpWRoMfd+G/GoppPIeP6JDaMMkMrEJnMZhKyyS6iKwVt5YKu02vCUyJM3Ug==}

  '@mapbox/unitbezier@0.0.1':
    resolution: {integrity: sha512-nMkuDXFv60aBr9soUG5q+GvZYL+2KZHVvsqFCzqnkGEf46U2fvmytHaEVc1/YZbiLn8X+eR3QzX1+dwDO1lxlw==}

  '@mapbox/vector-tile@2.0.4':
    resolution: {integrity: sha512-AkOLcbgGTdXScosBWwmmD7cDlvOjkg/DetGva26pIRiZPdeJYjYKarIlb4uxVzi6bwHO6EWH82eZ5Nuv4T5DUg==}

  '@mapbox/whoots-js@3.1.0':
    resolution: {integrity: sha512-Es6WcD0nO5l+2BOQS4uLfNPYQaNDfbot3X1XUoloz+x0mPDS3eeORZJl06HXjwBG1fOGwCRnzK88LMdxKRrd6Q==}
    engines: {node: '>=6.0.0'}

  '@maplibre/maplibre-gl-style-spec@24.4.1':
    resolution: {integrity: sha512-UKhA4qv1h30XT768ccSv5NjNCX+dgfoq2qlLVmKejspPcSQTYD4SrVucgqegmYcKcmwf06wcNAa/kRd0NHWbUg==}
    hasBin: true

  '@maplibre/mlt@1.1.2':
    resolution: {integrity: sha512-SQKdJ909VGROkA6ovJgtHNs9YXV4YXUPS+VaZ50I2Mt951SLlUm2Cv34x5Xwc1HiFlsd3h2Yrs5cn7xzqBmENw==}

  '@maplibre/vt-pbf@4.2.0':
    resolution: {integrity: sha512-bxrk/kQUwWXZgmqYgwOCnZCMONCRi3MJMqJdza4T3E4AeR5i+VyMnaJ8iDWtWxdfEAJRtrzIOeJtxZSy5mFrFA==}

  '@popperjs/core@2.11.8':
    resolution: {integrity: sha512-P1st0aksCrn9sGZhp8GMYwBnQsbvAWsZAX44oXNNvLHGqAOcoVxmjZiohstwQ7SqKnbR47akdNi+uleWD8+g6A==}

  '@rolldown/pluginutils@1.0.0-beta.53':
    resolution: {integrity: sha512-vENRlFU4YbrwVqNDZ7fLvy+JR1CRkyr01jhSiDpE1u6py3OMzQfztQU2jxykW3ALNxO4kSlqIDeYyD0Y9RcQeQ==}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    resolution: {integrity: sha512-iDGS/h7D8t7tvZ1t6+WPK04KD0MwzLZrG0se1hzBjSi5fyxlsiggoJHwh18PCFNn7tG43OWb6pdZ6Y+rMlmyNQ==}
    cpu: [arm]
    os: [android]

  '@rollup/rollup-android-arm64@4.53.5':
    resolution: {integrity: sha512-wrSAViWvZHBMMlWk6EJhvg8/rjxzyEhEdgfMMjREHEq11EtJ6IP6yfcCH57YAEca2Oe3FNCE9DSTgU70EIGmVw==}
    cpu: [arm64]
    os: [android]

  '@rollup/rollup-darwin-arm64@4.53.5':
    resolution: {integrity: sha512-S87zZPBmRO6u1YXQLwpveZm4JfPpAa6oHBX7/ghSiGH3rz/KDgAu1rKdGutV+WUI6tKDMbaBJomhnT30Y2t4VQ==}
    cpu: [arm64]
    os: [darwin]

  '@rollup/rollup-darwin-x64@4.53.5':
    resolution: {integrity: sha512-YTbnsAaHo6VrAczISxgpTva8EkfQus0VPEVJCEaboHtZRIb6h6j0BNxRBOwnDciFTZLDPW5r+ZBmhL/+YpTZgA==}
    cpu: [x64]
    os: [darwin]

  '@rollup/rollup-freebsd-arm64@4.53.5':
    resolution: {integrity: sha512-1T8eY2J8rKJWzaznV7zedfdhD1BqVs1iqILhmHDq/bqCUZsrMt+j8VCTHhP0vdfbHK3e1IQ7VYx3jlKqwlf+vw==}
    cpu: [arm64]
    os: [freebsd]

  '@rollup/rollup-freebsd-x64@4.53.5':
    resolution: {integrity: sha512-sHTiuXyBJApxRn+VFMaw1U+Qsz4kcNlxQ742snICYPrY+DDL8/ZbaC4DVIB7vgZmp3jiDaKA0WpBdP0aqPJoBQ==}
    cpu: [x64]
    os: [freebsd]

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    resolution: {integrity: sha512-dV3T9MyAf0w8zPVLVBptVlzaXxka6xg1f16VAQmjg+4KMSTWDvhimI/Y6mp8oHwNrmnmVl9XxJ/w/mO4uIQONA==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    resolution: {integrity: sha512-wIGYC1x/hyjP+KAu9+ewDI+fi5XSNiUi9Bvg6KGAh2TsNMA3tSEs+Sh6jJ/r4BV/bx/CyWu2ue9kDnIdRyafcQ==}
    cpu: [arm]
    os: [linux]

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    resolution: {integrity: sha512-Y+qVA0D9d0y2FRNiG9oM3Hut/DgODZbU9I8pLLPwAsU0tUKZ49cyV1tzmB/qRbSzGvY8lpgGkJuMyuhH7Ma+Vg==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    resolution: {integrity: sha512-juaC4bEgJsyFVfqhtGLz8mbopaWD+WeSOYr5E16y+1of6KQjc0BpwZLuxkClqY1i8sco+MdyoXPNiCkQou09+g==}
    cpu: [arm64]
    os: [linux]

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    resolution: {integrity: sha512-rIEC0hZ17A42iXtHX+EPJVL/CakHo+tT7W0pbzdAGuWOt2jxDFh7A/lRhsNHBcqL4T36+UiAgwO8pbmn3dE8wA==}
    cpu: [loong64]
    os: [linux]

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    resolution: {integrity: sha512-T7l409NhUE552RcAOcmJHj3xyZ2h7vMWzcwQI0hvn5tqHh3oSoclf9WgTl+0QqffWFG8MEVZZP1/OBglKZx52Q==}
    cpu: [ppc64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    resolution: {integrity: sha512-7OK5/GhxbnrMcxIFoYfhV/TkknarkYC1hqUw1wU2xUN3TVRLNT5FmBv4KkheSG2xZ6IEbRAhTooTV2+R5Tk0lQ==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    resolution: {integrity: sha512-GwuDBE/PsXaTa76lO5eLJTyr2k8QkPipAyOrs4V/KJufHCZBJ495VCGJol35grx9xryk4V+2zd3Ri+3v7NPh+w==}
    cpu: [riscv64]
    os: [linux]

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    resolution: {integrity: sha512-IAE1Ziyr1qNfnmiQLHBURAD+eh/zH1pIeJjeShleII7Vj8kyEm2PF77o+lf3WTHDpNJcu4IXJxNO0Zluro8bOw==}
    cpu: [s390x]
    os: [linux]

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    resolution: {integrity: sha512-Pg6E+oP7GvZ4XwgRJBuSXZjcqpIW3yCBhK4BcsANvb47qMvAbCjR6E+1a/U2WXz1JJxp9/4Dno3/iSJLcm5auw==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-linux-x64-musl@4.53.5':
    resolution: {integrity: sha512-txGtluxDKTxaMDzUduGP0wdfng24y1rygUMnmlUJ88fzCCULCLn7oE5kb2+tRB+MWq1QDZT6ObT5RrR8HFRKqg==}
    cpu: [x64]
    os: [linux]

  '@rollup/rollup-openharmony-arm64@4.53.5':
    resolution: {integrity: sha512-3DFiLPnTxiOQV993fMc+KO8zXHTcIjgaInrqlG8zDp1TlhYl6WgrOHuJkJQ6M8zHEcntSJsUp1XFZSY8C1DYbg==}
    cpu: [arm64]
    os: [openharmony]

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    resolution: {integrity: sha512-nggc/wPpNTgjGg75hu+Q/3i32R00Lq1B6N1DO7MCU340MRKL3WZJMjA9U4K4gzy3dkZPXm9E1Nc81FItBVGRlA==}
    cpu: [arm64]
    os: [win32]

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    resolution: {integrity: sha512-U/54pTbdQpPLBdEzCT6NBCFAfSZMvmjr0twhnD9f4EIvlm9wy3jjQ38yQj1AGznrNO65EWQMgm/QUjuIVrYF9w==}
    cpu: [ia32]
    os: [win32]

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    resolution: {integrity: sha512-2NqKgZSuLH9SXBBV2dWNRCZmocgSOx8OJSdpRaEcRlIfX8YrKxUT6z0F1NpvDVhOsl190UFTRh2F2WDWWCYp3A==}
    cpu: [x64]
    os: [win32]

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    resolution: {integrity: sha512-JRpZUhCfhZ4keB5v0fe02gQJy05GqboPOaxvjugW04RLSYYoB/9t2lx2u/tMs/Na/1NXfY8QYjgRljRpN+MjTQ==}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/node@4.1.18':
    resolution: {integrity: sha512-DoR7U1P7iYhw16qJ49fgXUlry1t4CpXeErJHnQ44JgTSKMaZUdf17cfn5mHchfJ4KRBZRFA/Coo+MUF5+gOaCQ==}

  '@tailwindcss/oxide-android-arm64@4.1.18':
    resolution: {integrity: sha512-dJHz7+Ugr9U/diKJA0W6N/6/cjI+ZTAoxPf9Iz9BFRF2GzEX8IvXxFIi/dZBloVJX/MZGvRuFA9rqwdiIEZQ0Q==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [android]

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    resolution: {integrity: sha512-Gc2q4Qhs660bhjyBSKgq6BYvwDz4G+BuyJ5H1xfhmDR3D8HnHCmT/BSkvSL0vQLy/nkMLY20PQ2OoYMO15Jd0A==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [darwin]

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    resolution: {integrity: sha512-FL5oxr2xQsFrc3X9o1fjHKBYBMD1QZNyc1Xzw/h5Qu4XnEBi3dZn96HcHm41c/euGV+GRiXFfh2hUCyKi/e+yw==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [darwin]

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    resolution: {integrity: sha512-Fj+RHgu5bDodmV1dM9yAxlfJwkkWvLiRjbhuO2LEtwtlYlBgiAT4x/j5wQr1tC3SANAgD+0YcmWVrj8R9trVMA==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [freebsd]

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    resolution: {integrity: sha512-Fp+Wzk/Ws4dZn+LV2Nqx3IilnhH51YZoRaYHQsVq3RQvEl+71VGKFpkfHrLM/Li+kt5c0DJe/bHXK1eHgDmdiA==}
    engines: {node: '>= 10'}
    cpu: [arm]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    resolution: {integrity: sha512-S0n3jboLysNbh55Vrt7pk9wgpyTTPD0fdQeh7wQfMqLPM/Hrxi+dVsLsPrycQjGKEQk85Kgbx+6+QnYNiHalnw==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    resolution: {integrity: sha512-1px92582HkPQlaaCkdRcio71p8bc8i/ap5807tPRDK/uw953cauQBT8c5tVGkOwrHMfc2Yh6UuxaH4vtTjGvHg==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    resolution: {integrity: sha512-v3gyT0ivkfBLoZGF9LyHmts0Isc8jHZyVcbzio6Wpzifg/+5ZJpDiRiUhDLkcr7f/r38SWNe7ucxmGW3j3Kb/g==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    resolution: {integrity: sha512-bhJ2y2OQNlcRwwgOAGMY0xTFStt4/wyU6pvI6LSuZpRgKQwxTec0/3Scu91O8ir7qCR3AuepQKLU/kX99FouqQ==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [linux]

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    resolution: {integrity: sha512-LffYTvPjODiP6PT16oNeUQJzNVyJl1cjIebq/rWWBF+3eDst5JGEFSc5cWxyRCJ0Mxl+KyIkqRxk1XPEs9x8TA==}
    engines: {node: '>=14.0.0'}
    cpu: [wasm32]
    bundledDependencies:
      - '@napi-rs/wasm-runtime'
      - '@emnapi/core'
      - '@emnapi/runtime'
      - '@tybys/wasm-util'
      - '@emnapi/wasi-threads'
      - tslib

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    resolution: {integrity: sha512-HjSA7mr9HmC8fu6bdsZvZ+dhjyGCLdotjVOgLA2vEqxEBZaQo9YTX4kwgEvPCpRh8o4uWc4J/wEoFzhEmjvPbA==}
    engines: {node: '>= 10'}
    cpu: [arm64]
    os: [win32]

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    resolution: {integrity: sha512-bJWbyYpUlqamC8dpR7pfjA0I7vdF6t5VpUGMWRkXVE3AXgIZjYUYAK7II1GNaxR8J1SSrSrppRar8G++JekE3Q==}
    engines: {node: '>= 10'}
    cpu: [x64]
    os: [win32]

  '@tailwindcss/oxide@4.1.18':
    resolution: {integrity: sha512-EgCR5tTS5bUSKQgzeMClT6iCY3ToqE1y+ZB0AKldj809QXk1Y+3jB0upOYZrn9aGIzPtUsP7sX4QQ4XtjBB95A==}
    engines: {node: '>= 10'}

  '@tailwindcss/vite@4.1.18':
    resolution: {integrity: sha512-jVA+/UpKL1vRLg6Hkao5jldawNmRo7mQYrZtNHMIVpLfLhDml5nMRUo/8MwoX2vNXvnaXNNMedrMfMugAVX1nA==}
    peerDependencies:
      vite: ^5.2.0 || ^6 || ^7

  '@types/estree@1.0.8':
    resolution: {integrity: sha512-dWHzHa2WqEXI/O1E9OjrocMTKJl2mSrEolh1Iomrv6U+JuNwaHXsXx9bLu5gG7BUWFIN0skIQJQ/L1rIex4X6w==}

  '@types/geojson-vt@3.2.5':
    resolution: {integrity: sha512-qDO7wqtprzlpe8FfQ//ClPV9xiuoh2nkIgiouIptON9w5jvD/fA4szvP9GBlDVdJ5dldAl0kX/sy3URbWwLx0g==}

  '@types/geojson@7946.0.16':
    resolution: {integrity: sha512-6C8nqWur3j98U6+lXDfTUWIfgvZU+EumvpHKcYjujKH7woYyLj2sUmff0tRhrqM7BohUw7Pz3ZB1jj2gW9Fvmg==}

  '@types/lodash@4.17.21':
    resolution: {integrity: sha512-FOvQ0YPD5NOfPgMzJihoT+Za5pdkDJWcbpuj1DjaKZIr/gxodQjY/uWEFlTNqW2ugXHUiL8lRQgw63dzKHZdeQ==}

  '@types/node@24.10.4':
    resolution: {integrity: sha512-vnDVpYPMzs4wunl27jHrfmwojOGKya0xyM3sH+UE5iv5uPS6vX7UIoh6m+vQc5LGBq52HBKPIn/zcSZVzeDEZg==}

  '@types/resize-observer-browser@0.1.11':
    resolution: {integrity: sha512-cNw5iH8JkMkb3QkCoe7DaZiawbDQEUX8t7iuQaRTyLOyQCR2h+ibBD4GJt7p5yhUHrlOeL7ZtbxNHeipqNsBzQ==}

  '@types/supercluster@7.1.3':
    resolution: {integrity: sha512-Z0pOY34GDFl3Q6hUFYf3HkTwKEE02e7QgtJppBt+beEAxnyOpJua+voGFvxINBHa06GwLFFym7gRPY2SiKIfIA==}

  '@vitejs/plugin-vue@6.0.3':
    resolution: {integrity: sha512-TlGPkLFLVOY3T7fZrwdvKpjprR3s4fxRln0ORDo1VQ7HHyxJwTlrjKU3kpVWTlaAjIEuCTokmjkZnr8Tpc925w==}
    engines: {node: ^20.19.0 || >=22.12.0}
    peerDependencies:
      vite: ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0-0
      vue: ^3.2.25

  '@volar/language-core@2.4.26':
    resolution: {integrity: sha512-hH0SMitMxnB43OZpyF1IFPS9bgb2I3bpCh76m2WEK7BE0A0EzpYsRp0CCH2xNKshr7kacU5TQBLYn4zj7CG60A==}

  '@volar/source-map@2.4.26':
    resolution: {integrity: sha512-JJw0Tt/kSFsIRmgTQF4JSt81AUSI1aEye5Zl65EeZ8H35JHnTvFGmpDOBn5iOxd48fyGE+ZvZBp5FcgAy/1Qhw==}

  '@volar/typescript@2.4.26':
    resolution: {integrity: sha512-N87ecLD48Sp6zV9zID/5yuS1+5foj0DfuYGdQ6KHj/IbKvyKv1zNX6VCmnKYwtmHadEO6mFc2EKISiu3RDPAvA==}

  '@vue/compiler-core@3.5.25':
    resolution: {integrity: sha512-vay5/oQJdsNHmliWoZfHPoVZZRmnSWhug0BYT34njkYTPqClh3DNWLkZNJBVSjsNMrg0CCrBfoKkjZQPM/QVUw==}

  '@vue/compiler-dom@3.5.25':
    resolution: {integrity: sha512-4We0OAcMZsKgYoGlMjzYvaoErltdFI2/25wqanuTu+S4gismOTRTBPi4IASOjxWdzIwrYSjnqONfKvuqkXzE2Q==}

  '@vue/compiler-sfc@3.5.25':
    resolution: {integrity: sha512-PUgKp2rn8fFsI++lF2sO7gwO2d9Yj57Utr5yEsDf3GNaQcowCLKL7sf+LvVFvtJDXUp/03+dC6f2+LCv5aK1ag==}

  '@vue/compiler-ssr@3.5.25':
    resolution: {integrity: sha512-ritPSKLBcParnsKYi+GNtbdbrIE1mtuFEJ4U1sWeuOMlIziK5GtOL85t5RhsNy4uWIXPgk+OUdpnXiTdzn8o3A==}

  '@vue/devtools-api@7.7.9':
    resolution: {integrity: sha512-kIE8wvwlcZ6TJTbNeU2HQNtaxLx3a84aotTITUuL/4bzfPxzajGBOoqjMhwZJ8L9qFYDU/lAYMEEm11dnZOD6g==}

  '@vue/devtools-kit@7.7.9':
    resolution: {integrity: sha512-PyQ6odHSgiDVd4hnTP+aDk2X4gl2HmLDfiyEnn3/oV+ckFDuswRs4IbBT7vacMuGdwY/XemxBoh302ctbsptuA==}

  '@vue/devtools-shared@7.7.9':
    resolution: {integrity: sha512-iWAb0v2WYf0QWmxCGy0seZNDPdO3Sp5+u78ORnyeonS6MT4PC7VPrryX2BpMJrwlDeaZ6BD4vP4XKjK0SZqaeA==}

  '@vue/language-core@3.1.8':
    resolution: {integrity: sha512-PfwAW7BLopqaJbneChNL6cUOTL3GL+0l8paYP5shhgY5toBNidWnMXWM+qDwL7MC9+zDtzCF2enT8r6VPu64iw==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

  '@vue/reactivity@3.5.25':
    resolution: {integrity: sha512-5xfAypCQepv4Jog1U4zn8cZIcbKKFka3AgWHEFQeK65OW+Ys4XybP6z2kKgws4YB43KGpqp5D/K3go2UPPunLA==}

  '@vue/runtime-core@3.5.25':
    resolution: {integrity: sha512-Z751v203YWwYzy460bzsYQISDfPjHTl+6Zzwo/a3CsAf+0ccEjQ8c+0CdX1WsumRTHeywvyUFtW6KvNukT/smA==}

  '@vue/runtime-dom@3.5.25':
    resolution: {integrity: sha512-a4WrkYFbb19i9pjkz38zJBg8wa/rboNERq3+hRRb0dHiJh13c+6kAbgqCPfMaJ2gg4weWD3APZswASOfmKwamA==}

  '@vue/server-renderer@3.5.25':
    resolution: {integrity: sha512-UJaXR54vMG61i8XNIzTSf2Q7MOqZHpp8+x3XLGtE3+fL+nQd+k7O5+X3D/uWrnQXOdMw5VPih+Uremcw+u1woQ==}
    peerDependencies:
      vue: 3.5.25

  '@vue/shared@3.5.25':
    resolution: {integrity: sha512-AbOPdQQnAnzs58H2FrrDxYj/TJfmeS2jdfEEhgiKINy+bnOANmVizIEgq1r+C5zsbs6l1CCQxtcj71rwNQ4jWg==}

  '@vue/tsconfig@0.8.1':
    resolution: {integrity: sha512-aK7feIWPXFSUhsCP9PFqPyFOcz4ENkb8hZ2pneL6m2UjCkccvaOhC/5KCKluuBufvp2KzkbdA2W2pk20vLzu3g==}
    peerDependencies:
      typescript: 5.x
      vue: ^3.4.0
    peerDependenciesMeta:
      typescript:
        optional: true
      vue:
        optional: true

  alien-signals@3.1.1:
    resolution: {integrity: sha512-ogkIWbVrLwKtHY6oOAXaYkAxP+cTH7V5FZ5+Tm4NZFd8VDZ6uNMDrfzqctTZ42eTMCSR3ne3otpcxmqSnFfPYA==}

  autoprefixer@10.4.23:
    resolution: {integrity: sha512-YYTXSFulfwytnjAPlw8QHncHJmlvFKtczb8InXaAx9Q0LbfDnfEYDE55omerIJKihhmU61Ft+cAOSzQVaBUmeA==}
    engines: {node: ^10 || ^12 || >=14}
    hasBin: true
    peerDependencies:
      postcss: ^8.1.0

  baseline-browser-mapping@2.9.9:
    resolution: {integrity: sha512-V8fbOCSeOFvlDj7LLChUcqbZrdKD9RU/VR260piF1790vT0mfLSwGc/Qzxv3IqiTukOpNtItePa0HBpMAj7MDg==}
    hasBin: true

  birpc@2.9.0:
    resolution: {integrity: sha512-KrayHS5pBi69Xi9JmvoqrIgYGDkD6mcSe/i6YKi3w5kekCLzrX4+nawcXqrj2tIp50Kw/mT/s3p+GVK0A0sKxw==}

  browserslist@4.28.1:
    resolution: {integrity: sha512-ZC5Bd0LgJXgwGqUknZY/vkUQ04r8NXnJZ3yYi4vDmSiZmC/pdSN0NbNRPxZpbtO4uAfDUAFffO8IZoM3Gj8IkA==}
    engines: {node: ^6 || ^7 || ^8 || ^9 || ^10 || ^11 || ^12 || >=13.7}
    hasBin: true

  caniuse-lite@1.0.30001760:
    resolution: {integrity: sha512-7AAMPcueWELt1p3mi13HR/LHH0TJLT11cnwDJEs3xA4+CK/PLKeO9Kl1oru24htkyUKtkGCvAx4ohB0Ttry8Dw==}

  copy-anything@4.0.5:
    resolution: {integrity: sha512-7Vv6asjS4gMOuILabD3l739tsaxFQmC+a7pLZm02zyvs8p977bL3zEgq3yDk5rn9B0PbYgIv++jmHcuUab4RhA==}
    engines: {node: '>=18'}

  csstype@3.2.3:
    resolution: {integrity: sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==}

  date-fns-tz@2.0.1:
    resolution: {integrity: sha512-fJCG3Pwx8HUoLhkepdsP7Z5RsucUi+ZBOxyM5d0ZZ6c4SdYustq0VMmOu6Wf7bli+yS/Jwp91TOCqn9jMcVrUA==}
    peerDependencies:
      date-fns: 2.x

  date-fns@2.30.0:
    resolution: {integrity: sha512-fnULvOpxnC5/Vg3NCiWelDsLiUc9bRwAPs/+LfTLNvetFCtCTN+yQz15C/fs4AwX1R9K5GLtLfn8QW+dWisaAw==}
    engines: {node: '>=0.11'}

  detect-libc@2.1.2:
    resolution: {integrity: sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==}
    engines: {node: '>=8'}

  earcut@3.0.2:
    resolution: {integrity: sha512-X7hshQbLyMJ/3RPhyObLARM2sNxxmRALLKx1+NVFFnQ9gKzmCrxm9+uLIAdBcvc8FNLpctqlQ2V6AE92Ol9UDQ==}

  electron-to-chromium@1.5.267:
    resolution: {integrity: sha512-0Drusm6MVRXSOJpGbaSVgcQsuB4hEkMpHXaVstcPmhu5LIedxs1xNK/nIxmQIU/RPC0+1/o0AVZfBTkTNJOdUw==}

  enhanced-resolve@5.18.4:
    resolution: {integrity: sha512-LgQMM4WXU3QI+SYgEc2liRgznaD5ojbmY3sb8LxyguVkIg5FxdpTkvk72te2R38/TGKxH634oLxXRGY6d7AP+Q==}
    engines: {node: '>=10.13.0'}

  entities@4.5.0:
    resolution: {integrity: sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==}
    engines: {node: '>=0.12'}

  esbuild@0.27.2:
    resolution: {integrity: sha512-HyNQImnsOC7X9PMNaCIeAm4ISCQXs5a5YasTXVliKv4uuBo1dKrG0A+uQS8M5eXjVMnLg3WgXaKvprHlFJQffw==}
    engines: {node: '>=18'}
    hasBin: true

  escalade@3.2.0:
    resolution: {integrity: sha512-WUj2qlxaQtO4g6Pq5c29GTcWGDyd8itL8zTlipgECz3JesAiiOKotd8JU6otB3PACgG6xkJUyVhboMS+bje/jA==}
    engines: {node: '>=6'}

  estree-walker@2.0.2:
    resolution: {integrity: sha512-Rfkk/Mp/DL7JVje3u18FxFujQlTNR2q6QfMSMB7AvCBx91NGj/ba3kCfza0f6dVDbw7YlRf/nDrn7pQrCCyQ/w==}

  fdir@6.5.0:
    resolution: {integrity: sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==}
    engines: {node: '>=12.0.0'}
    peerDependencies:
      picomatch: ^3 || ^4
    peerDependenciesMeta:
      picomatch:
        optional: true

  fraction.js@5.3.4:
    resolution: {integrity: sha512-1X1NTtiJphryn/uLQz3whtY6jK3fTqoE3ohKs0tT+Ujr1W59oopxmoEh7Lu5p6vBaPbgoM0bzveAW4Qi5RyWDQ==}

  fsevents@2.3.3:
    resolution: {integrity: sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==}
    engines: {node: ^8.16.0 || ^10.6.0 || >=11.0.0}
    os: [darwin]

  geojson-vt@4.0.2:
    resolution: {integrity: sha512-AV9ROqlNqoZEIJGfm1ncNjEXfkz2hdFlZf0qkVfmkwdKa8vj7H16YUOT81rJw1rdFhyEDlN2Tds91p/glzbl5A==}

  get-stream@6.0.1:
    resolution: {integrity: sha512-ts6Wi+2j3jQjqi70w5AlN8DFnkSwC+MqmxEzdEALB2qXZYV3X/b1CTfgPLGJNMeAWxdPfU8FO1ms3NUfaHCPYg==}
    engines: {node: '>=10'}

  gl-matrix@3.4.4:
    resolution: {integrity: sha512-latSnyDNt/8zYUB6VIJ6PCh2jBjJX6gnDsoCZ7LyW7GkqrD51EWwa9qCoGixj8YqBtETQK/xY7OmpTF8xz1DdQ==}

  graceful-fs@4.2.11:
    resolution: {integrity: sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==}

  hookable@5.5.3:
    resolution: {integrity: sha512-Yc+BQe8SvoXH1643Qez1zqLRmbA5rCL+sSmk6TVos0LWVfNIB7PGncdlId77WzLGSIB5KaWgTaNTs2lNVEI6VQ==}

  is-what@5.5.0:
    resolution: {integrity: sha512-oG7cgbmg5kLYae2N5IVd3jm2s+vldjxJzK1pcu9LfpGuQ93MQSzo0okvRna+7y5ifrD+20FE8FvjusyGaz14fw==}
    engines: {node: '>=18'}

  jiti@2.6.1:
    resolution: {integrity: sha512-ekilCSN1jwRvIbgeg/57YFh8qQDNbwDb9xT/qu2DAHbFFZUicIl4ygVaAvzveMhMVr3LnpSKTNnwt8PoOfmKhQ==}
    hasBin: true

  json-stringify-pretty-compact@4.0.0:
    resolution: {integrity: sha512-3CNZ2DnrpByG9Nqj6Xo8vqbjT4F6N+tb4Gb28ESAZjYZ5yqvmc56J+/kuIwkaAMOyblTQhUW7PxMkUb8Q36N3Q==}

  kdbush@4.0.2:
    resolution: {integrity: sha512-WbCVYJ27Sz8zi9Q7Q0xHC+05iwkm3Znipc2XTlrnJbsHMYktW4hPhXUE8Ys1engBrvffoSCqbil1JQAa7clRpA==}

  lightningcss-android-arm64@1.30.2:
    resolution: {integrity: sha512-BH9sEdOCahSgmkVhBLeU7Hc9DWeZ1Eb6wNS6Da8igvUwAe0sqROHddIlvU06q3WyXVEOYDZ6ykBZQnjTbmo4+A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [android]

  lightningcss-darwin-arm64@1.30.2:
    resolution: {integrity: sha512-ylTcDJBN3Hp21TdhRT5zBOIi73P6/W0qwvlFEk22fkdXchtNTOU4Qc37SkzV+EKYxLouZ6M4LG9NfZ1qkhhBWA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [darwin]

  lightningcss-darwin-x64@1.30.2:
    resolution: {integrity: sha512-oBZgKchomuDYxr7ilwLcyms6BCyLn0z8J0+ZZmfpjwg9fRVZIR5/GMXd7r9RH94iDhld3UmSjBM6nXWM2TfZTQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [darwin]

  lightningcss-freebsd-x64@1.30.2:
    resolution: {integrity: sha512-c2bH6xTrf4BDpK8MoGG4Bd6zAMZDAXS569UxCAGcA7IKbHNMlhGQ89eRmvpIUGfKWNVdbhSbkQaWhEoMGmGslA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [freebsd]

  lightningcss-linux-arm-gnueabihf@1.30.2:
    resolution: {integrity: sha512-eVdpxh4wYcm0PofJIZVuYuLiqBIakQ9uFZmipf6LF/HRj5Bgm0eb3qL/mr1smyXIS1twwOxNWndd8z0E374hiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm]
    os: [linux]

  lightningcss-linux-arm64-gnu@1.30.2:
    resolution: {integrity: sha512-UK65WJAbwIJbiBFXpxrbTNArtfuznvxAJw4Q2ZGlU8kPeDIWEX1dg3rn2veBVUylA2Ezg89ktszWbaQnxD/e3A==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-arm64-musl@1.30.2:
    resolution: {integrity: sha512-5Vh9dGeblpTxWHpOx8iauV02popZDsCYMPIgiuw97OJ5uaDsL86cnqSFs5LZkG3ghHoX5isLgWzMs+eD1YzrnA==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [linux]

  lightningcss-linux-x64-gnu@1.30.2:
    resolution: {integrity: sha512-Cfd46gdmj1vQ+lR6VRTTadNHu6ALuw2pKR9lYq4FnhvgBc4zWY1EtZcAc6EffShbb1MFrIPfLDXD6Xprbnni4w==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-linux-x64-musl@1.30.2:
    resolution: {integrity: sha512-XJaLUUFXb6/QG2lGIW6aIk6jKdtjtcffUT0NKvIqhSBY3hh9Ch+1LCeH80dR9q9LBjG3ewbDjnumefsLsP6aiA==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [linux]

  lightningcss-win32-arm64-msvc@1.30.2:
    resolution: {integrity: sha512-FZn+vaj7zLv//D/192WFFVA0RgHawIcHqLX9xuWiQt7P0PtdFEVaxgF9rjM/IRYHQXNnk61/H/gb2Ei+kUQ4xQ==}
    engines: {node: '>= 12.0.0'}
    cpu: [arm64]
    os: [win32]

  lightningcss-win32-x64-msvc@1.30.2:
    resolution: {integrity: sha512-5g1yc73p+iAkid5phb4oVFMB45417DkRevRbt/El/gKXJk4jid+vPFF/AXbxn05Aky8PapwzZrdJShv5C0avjw==}
    engines: {node: '>= 12.0.0'}
    cpu: [x64]
    os: [win32]

  lightningcss@1.30.2:
    resolution: {integrity: sha512-utfs7Pr5uJyyvDETitgsaqSyjCb2qNRAtuqUeWIAKztsOYdcACf2KtARYXg2pSvhkt+9NfoaNY7fxjl6nuMjIQ==}
    engines: {node: '>= 12.0.0'}

  lodash@4.17.21:
    resolution: {integrity: sha512-v2kDEe57lecTulaDIuNTPy3Ry4gLGJ6Z1O3vE1krgXZNrsQ+LFTGHVxVjcXPs17LhbZVGedAJv8XZ1tvj5FvSg==}

  magic-string@0.30.21:
    resolution: {integrity: sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==}

  maplibre-gl@5.15.0:
    resolution: {integrity: sha512-pPeu/t4yPDX/+Uf9ibLUdmaKbNMlGxMAX+tBednYukol2qNk2TZXAlhdohWxjVvTO3is8crrUYv3Ok02oAaKzA==}
    engines: {node: '>=16.14.0', npm: '>=8.1.0'}

  minimist@1.2.8:
    resolution: {integrity: sha512-2yyAR8qBkN3YuheJanUpWC5U3bb5osDywNB8RzDVlDwDHbocAJveqqj1u8+SVD7jkWT4yvsHCpWqqWqAxb0zCA==}

  mitt@3.0.1:
    resolution: {integrity: sha512-vKivATfr97l2/QBCYAkXYDbrIWPM2IIKEl7YPhjCvKlG3kE2gm+uBo6nEXK3M5/Ffh/FLpKExzOQ3JJoJGFKBw==}

  muggle-string@0.4.1:
    resolution: {integrity: sha512-VNTrAak/KhO2i8dqqnqnAHOa3cYBwXEZe9h+D5h/1ZqFSTEFHdM65lR7RoIqq3tBBYavsOXV84NoHXZ0AkPyqQ==}

  murmurhash-js@1.0.0:
    resolution: {integrity: sha512-TvmkNhkv8yct0SVBSy+o8wYzXjE4Zz3PCesbfs8HiCXXdcTuocApFv11UWlNFWKYsP2okqrhb7JNlSm9InBhIw==}

  nanoid@3.3.11:
    resolution: {integrity: sha512-N8SpfPUnUp1bK+PMYW8qSWdl9U+wwNWI4QKxOYDy9JAro3WMX7p2OeVRF9v+347pnakNevPmiHhNmZ2HbFA76w==}
    engines: {node: ^10 || ^12 || ^13.7 || ^14 || >=15.0.1}
    hasBin: true

  node-releases@2.0.27:
    resolution: {integrity: sha512-nmh3lCkYZ3grZvqcCH+fjmQ7X+H0OeZgP40OierEaAptX4XofMh5kwNbWh7lBduUzCcV/8kZ+NDLCwm2iorIlA==}

  path-browserify@1.0.1:
    resolution: {integrity: sha512-b7uo2UCUOYZcnF/3ID0lulOJi/bafxa1xPe7ZPsammBSpjSWQkjNxlt635YGS2MiR9GjvuXCtz2emr3jbsz98g==}

  pbf@4.0.1:
    resolution: {integrity: sha512-SuLdBvS42z33m8ejRbInMapQe8n0D3vN/Xd5fmWM3tufNgRQFBpaW2YVJxQZV4iPNqb0vEFvssMEo5w9c6BTIA==}
    hasBin: true

  perfect-debounce@1.0.0:
    resolution: {integrity: sha512-xCy9V055GLEqoFaHoC1SoLIaLmWctgCUaBaWxDZ7/Zx4CTyX7cJQLJOok/orfjZAh9kEYpjJa4d0KcJmCbctZA==}

  picocolors@1.1.1:
    resolution: {integrity: sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==}

  picomatch@4.0.3:
    resolution: {integrity: sha512-5gTmgEY/sqK6gFXLIsQNH19lWb4ebPDLA4SdLP7dsWkIXHWlG66oPuVvXSGFPppYZz8ZDZq0dYYrbHfBCVUb1Q==}
    engines: {node: '>=12'}

  pinia@3.0.4:
    resolution: {integrity: sha512-l7pqLUFTI/+ESXn6k3nu30ZIzW5E2WZF/LaHJEpoq6ElcLD+wduZoB2kBN19du6K/4FDpPMazY2wJr+IndBtQw==}
    peerDependencies:
      typescript: '>=4.5.0'
      vue: ^3.5.11
    peerDependenciesMeta:
      typescript:
        optional: true

  postcss-value-parser@4.2.0:
    resolution: {integrity: sha512-1NNCs6uurfkVbeXG4S8JFT9t19m45ICnif8zWLd5oPSZ50QnwMfK+H3jv408d4jw/7Bttv5axS5IiHoLaVNHeQ==}

  postcss@8.5.6:
    resolution: {integrity: sha512-3Ybi1tAuwAP9s0r1UQ2J4n5Y0G05bJkpUIO0/bI9MhwmD70S5aTWbXGBwxHrelT+XM1k6dM0pk+SwNkpTRN7Pg==}
    engines: {node: ^10 || ^12 || >=14}

  potpack@2.1.0:
    resolution: {integrity: sha512-pcaShQc1Shq0y+E7GqJqvZj8DTthWV1KeHGdi0Z6IAin2Oi3JnLCOfwnCo84qc+HAp52wT9nK9H7FAJp5a44GQ==}

  protocol-buffers-schema@3.6.0:
    resolution: {integrity: sha512-TdDRD+/QNdrCGCE7v8340QyuXd4kIWIgapsE2+n/SaGiSSbomYl4TjHlvIoCWRpE7wFt02EpB35VVA2ImcBVqw==}

  quickselect@3.0.0:
    resolution: {integrity: sha512-XdjUArbK4Bm5fLLvlm5KpTFOiOThgfWWI4axAZDWg4E/0mKdZyI9tNEfds27qCi1ze/vwTR16kvmmGhRra3c2g==}

  resolve-protobuf-schema@2.1.0:
    resolution: {integrity: sha512-kI5ffTiZWmJaS/huM8wZfEMer1eRd7oJQhDuxeCLe3t7N7mX3z94CN0xPxBQxFYQTSNz9T0i+v6inKqSdK8xrQ==}

  rfdc@1.4.1:
    resolution: {integrity: sha512-q1b3N5QkRUWUl7iyylaaj3kOpIT0N2i9MqIEQXP73GVsN9cw3fdx8X63cEmWhJGi2PPCF23Ijp7ktmd39rawIA==}

  rollup@4.53.5:
    resolution: {integrity: sha512-iTNAbFSlRpcHeeWu73ywU/8KuU/LZmNCSxp6fjQkJBD3ivUb8tpDrXhIxEzA05HlYMEwmtaUnb3RP+YNv162OQ==}
    engines: {node: '>=18.0.0', npm: '>=8.0.0'}
    hasBin: true

  rw@1.3.3:
    resolution: {integrity: sha512-PdhdWy89SiZogBLaw42zdeqtRJ//zFd2PgQavcICDUgJT5oW10QCRKbJ6bg4r0/UY2M6BWd5tkxuGFRvCkgfHQ==}

  source-map-js@1.2.1:
    resolution: {integrity: sha512-UXWMKhLOwVKb728IUtQPXxfYU+usdybtUrK/8uGE8CQMvrhOpwvzDBwj0QhSL7MQc7vIsISBG8VQ8+IDQxpfQA==}
    engines: {node: '>=0.10.0'}

  speakingurl@14.0.1:
    resolution: {integrity: sha512-1POYv7uv2gXoyGFpBCmpDVSNV74IfsWlDW216UPjbWufNf+bSU6GdbDsxdcxtfwb4xlI3yxzOTKClUosxARYrQ==}
    engines: {node: '>=0.10.0'}

  supercluster@8.0.1:
    resolution: {integrity: sha512-IiOea5kJ9iqzD2t7QJq/cREyLHTtSmUT6gQsweojg9WH2sYJqZK9SswTu6jrscO6D1G5v5vYZ9ru/eq85lXeZQ==}

  superjson@2.2.6:
    resolution: {integrity: sha512-H+ue8Zo4vJmV2nRjpx86P35lzwDT3nItnIsocgumgr0hHMQ+ZGq5vrERg9kJBo5AWGmxZDhzDo+WVIJqkB0cGA==}
    engines: {node: '>=16'}

  tailwindcss@4.1.18:
    resolution: {integrity: sha512-4+Z+0yiYyEtUVCScyfHCxOYP06L5Ne+JiHhY2IjR2KWMIWhJOYZKLSGZaP5HkZ8+bY0cxfzwDE5uOmzFXyIwxw==}

  tapable@2.3.0:
    resolution: {integrity: sha512-g9ljZiwki/LfxmQADO3dEY1CbpmXT5Hm2fJ+QaGKwSXUylMybePR7/67YW7jOrrvjEgL1Fmz5kzyAjWVWLlucg==}
    engines: {node: '>=6'}

  tinyglobby@0.2.15:
    resolution: {integrity: sha512-j2Zq4NyQYG5XMST4cbs02Ak8iJUdxRM0XI5QyxXuZOzKOINmWurp3smXu3y5wDcJrptwpSjgXHzIQxR0omXljQ==}
    engines: {node: '>=12.0.0'}

  tinyqueue@3.0.0:
    resolution: {integrity: sha512-gRa9gwYU3ECmQYv3lslts5hxuIa90veaEcxDYuu3QGOIAEM2mOZkVHp48ANJuu1CURtRdHKUBY5Lm1tHV+sD4g==}

  typescript@5.9.3:
    resolution: {integrity: sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==}
    engines: {node: '>=14.17'}
    hasBin: true

  undici-types@7.16.0:
    resolution: {integrity: sha512-Zz+aZWSj8LE6zoxD+xrjh4VfkIG8Ya6LvYkZqtUQGJPZjYl53ypCaUwWqo7eI0x66KBGeRo+mlBEkMSeSZ38Nw==}

  update-browserslist-db@1.2.3:
    resolution: {integrity: sha512-Js0m9cx+qOgDxo0eMiFGEueWztz+d4+M3rGlmKPT+T4IS/jP4ylw3Nwpu6cpTTP8R1MAC1kF4VbdLt3ARf209w==}
    hasBin: true
    peerDependencies:
      browserslist: '>= 4.21.0'

  v-calendar@3.1.2:
    resolution: {integrity: sha512-QDWrnp4PWCpzUblctgo4T558PrHgHzDtQnTeUNzKxfNf29FkCeFpwGd9bKjAqktaa2aJLcyRl45T5ln1ku34kg==}
    peerDependencies:
      '@popperjs/core': ^2.0.0
      vue: ^3.2.0

  vite@7.3.0:
    resolution: {integrity: sha512-dZwN5L1VlUBewiP6H9s2+B3e3Jg96D0vzN+Ry73sOefebhYr9f94wwkMNN/9ouoU8pV1BqA1d1zGk8928cx0rg==}
    engines: {node: ^20.19.0 || >=22.12.0}
    hasBin: true
    peerDependencies:
      '@types/node': ^20.19.0 || >=22.12.0
      jiti: '>=1.21.0'
      less: ^4.0.0
      lightningcss: ^1.21.0
      sass: ^1.70.0
      sass-embedded: ^1.70.0
      stylus: '>=0.54.8'
      sugarss: ^5.0.0
      terser: ^5.16.0
      tsx: ^4.8.1
      yaml: ^2.4.2
    peerDependenciesMeta:
      '@types/node':
        optional: true
      jiti:
        optional: true
      less:
        optional: true
      lightningcss:
        optional: true
      sass:
        optional: true
      sass-embedded:
        optional: true
      stylus:
        optional: true
      sugarss:
        optional: true
      terser:
        optional: true
      tsx:
        optional: true
      yaml:
        optional: true

  vscode-uri@3.1.0:
    resolution: {integrity: sha512-/BpdSx+yCQGnCvecbyXdxHDkuk55/G3xwnC0GqY4gmQ3j+A+g8kzzgB4Nk/SINjqn6+waqw3EgbVF2QKExkRxQ==}

  vue-screen-utils@1.0.0-beta.13:
    resolution: {integrity: sha512-EJ/8TANKhFj+LefDuOvZykwMr3rrLFPLNb++lNBqPOpVigT2ActRg6icH9RFQVm4nHwlHIHSGm5OY/Clar9yIg==}
    peerDependencies:
      vue: ^3.2.0

  vue-tsc@3.1.8:
    resolution: {integrity: sha512-deKgwx6exIHeZwF601P1ktZKNF0bepaSN4jBU3AsbldPx9gylUc1JDxYppl82yxgkAgaz0Y0LCLOi+cXe9HMYA==}
    hasBin: true
    peerDependencies:
      typescript: '>=5.0.0'

  vue@3.5.25:
    resolution: {integrity: sha512-YLVdgv2K13WJ6n+kD5owehKtEXwdwXuj2TTyJMsO7pSeKw2bfRNZGjhB7YzrpbMYj5b5QsUebHpOqR3R3ziy/g==}
    peerDependencies:
      typescript: '*'
    peerDependenciesMeta:
      typescript:
        optional: true

snapshots:

  '@babel/helper-string-parser@7.27.1': {}

  '@babel/helper-validator-identifier@7.28.5': {}

  '@babel/parser@7.28.5':
    dependencies:
      '@babel/types': 7.28.5

  '@babel/runtime@7.28.4': {}

  '@babel/types@7.28.5':
    dependencies:
      '@babel/helper-string-parser': 7.27.1
      '@babel/helper-validator-identifier': 7.28.5

  '@esbuild/aix-ppc64@0.27.2':
    optional: true

  '@esbuild/android-arm64@0.27.2':
    optional: true

  '@esbuild/android-arm@0.27.2':
    optional: true

  '@esbuild/android-x64@0.27.2':
    optional: true

  '@esbuild/darwin-arm64@0.27.2':
    optional: true

  '@esbuild/darwin-x64@0.27.2':
    optional: true

  '@esbuild/freebsd-arm64@0.27.2':
    optional: true

  '@esbuild/freebsd-x64@0.27.2':
    optional: true

  '@esbuild/linux-arm64@0.27.2':
    optional: true

  '@esbuild/linux-arm@0.27.2':
    optional: true

  '@esbuild/linux-ia32@0.27.2':
    optional: true

  '@esbuild/linux-loong64@0.27.2':
    optional: true

  '@esbuild/linux-mips64el@0.27.2':
    optional: true

  '@esbuild/linux-ppc64@0.27.2':
    optional: true

  '@esbuild/linux-riscv64@0.27.2':
    optional: true

  '@esbuild/linux-s390x@0.27.2':
    optional: true

  '@esbuild/linux-x64@0.27.2':
    optional: true

  '@esbuild/netbsd-arm64@0.27.2':
    optional: true

  '@esbuild/netbsd-x64@0.27.2':
    optional: true

  '@esbuild/openbsd-arm64@0.27.2':
    optional: true

  '@esbuild/openbsd-x64@0.27.2':
    optional: true

  '@esbuild/openharmony-arm64@0.27.2':
    optional: true

  '@esbuild/sunos-x64@0.27.2':
    optional: true

  '@esbuild/win32-arm64@0.27.2':
    optional: true

  '@esbuild/win32-ia32@0.27.2':
    optional: true

  '@esbuild/win32-x64@0.27.2':
    optional: true

  '@jridgewell/gen-mapping@0.3.13':
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/remapping@2.3.5':
    dependencies:
      '@jridgewell/gen-mapping': 0.3.13
      '@jridgewell/trace-mapping': 0.3.31

  '@jridgewell/resolve-uri@3.1.2': {}

  '@jridgewell/sourcemap-codec@1.5.5': {}

  '@jridgewell/trace-mapping@0.3.31':
    dependencies:
      '@jridgewell/resolve-uri': 3.1.2
      '@jridgewell/sourcemap-codec': 1.5.5

  '@mapbox/geojson-rewind@0.5.2':
    dependencies:
      get-stream: 6.0.1
      minimist: 1.2.8

  '@mapbox/jsonlint-lines-primitives@2.0.2': {}

  '@mapbox/point-geometry@1.1.0': {}

  '@mapbox/tiny-sdf@2.0.7': {}

  '@mapbox/unitbezier@0.0.1': {}

  '@mapbox/vector-tile@2.0.4':
    dependencies:
      '@mapbox/point-geometry': 1.1.0
      '@types/geojson': 7946.0.16
      pbf: 4.0.1

  '@mapbox/whoots-js@3.1.0': {}

  '@maplibre/maplibre-gl-style-spec@24.4.1':
    dependencies:
      '@mapbox/jsonlint-lines-primitives': 2.0.2
      '@mapbox/unitbezier': 0.0.1
      json-stringify-pretty-compact: 4.0.0
      minimist: 1.2.8
      quickselect: 3.0.0
      rw: 1.3.3
      tinyqueue: 3.0.0

  '@maplibre/mlt@1.1.2':
    dependencies:
      '@mapbox/point-geometry': 1.1.0

  '@maplibre/vt-pbf@4.2.0':
    dependencies:
      '@mapbox/point-geometry': 1.1.0
      '@mapbox/vector-tile': 2.0.4
      '@types/geojson-vt': 3.2.5
      '@types/supercluster': 7.1.3
      geojson-vt: 4.0.2
      pbf: 4.0.1
      supercluster: 8.0.1

  '@popperjs/core@2.11.8': {}

  '@rolldown/pluginutils@1.0.0-beta.53': {}

  '@rollup/rollup-android-arm-eabi@4.53.5':
    optional: true

  '@rollup/rollup-android-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-arm64@4.53.5':
    optional: true

  '@rollup/rollup-darwin-x64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-arm64@4.53.5':
    optional: true

  '@rollup/rollup-freebsd-x64@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-gnueabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm-musleabihf@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-arm64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-loong64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-ppc64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-riscv64-musl@4.53.5':
    optional: true

  '@rollup/rollup-linux-s390x-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-linux-x64-musl@4.53.5':
    optional: true

  '@rollup/rollup-openharmony-arm64@4.53.5':
    optional: true

  '@rollup/rollup-win32-arm64-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-ia32-msvc@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-gnu@4.53.5':
    optional: true

  '@rollup/rollup-win32-x64-msvc@4.53.5':
    optional: true

  '@tailwindcss/node@4.1.18':
    dependencies:
      '@jridgewell/remapping': 2.3.5
      enhanced-resolve: 5.18.4
      jiti: 2.6.1
      lightningcss: 1.30.2
      magic-string: 0.30.21
      source-map-js: 1.2.1
      tailwindcss: 4.1.18

  '@tailwindcss/oxide-android-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-arm64@4.1.18':
    optional: true

  '@tailwindcss/oxide-darwin-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-freebsd-x64@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm-gnueabihf@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-arm64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-gnu@4.1.18':
    optional: true

  '@tailwindcss/oxide-linux-x64-musl@4.1.18':
    optional: true

  '@tailwindcss/oxide-wasm32-wasi@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-arm64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide-win32-x64-msvc@4.1.18':
    optional: true

  '@tailwindcss/oxide@4.1.18':
    optionalDependencies:
      '@tailwindcss/oxide-android-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-arm64': 4.1.18
      '@tailwindcss/oxide-darwin-x64': 4.1.18
      '@tailwindcss/oxide-freebsd-x64': 4.1.18
      '@tailwindcss/oxide-linux-arm-gnueabihf': 4.1.18
      '@tailwindcss/oxide-linux-arm64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-arm64-musl': 4.1.18
      '@tailwindcss/oxide-linux-x64-gnu': 4.1.18
      '@tailwindcss/oxide-linux-x64-musl': 4.1.18
      '@tailwindcss/oxide-wasm32-wasi': 4.1.18
      '@tailwindcss/oxide-win32-arm64-msvc': 4.1.18
      '@tailwindcss/oxide-win32-x64-msvc': 4.1.18

  '@tailwindcss/vite@4.1.18(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))':
    dependencies:
      '@tailwindcss/node': 4.1.18
      '@tailwindcss/oxide': 4.1.18
      tailwindcss: 4.1.18
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)

  '@types/estree@1.0.8': {}

  '@types/geojson-vt@3.2.5':
    dependencies:
      '@types/geojson': 7946.0.16

  '@types/geojson@7946.0.16': {}

  '@types/lodash@4.17.21': {}

  '@types/node@24.10.4':
    dependencies:
      undici-types: 7.16.0

  '@types/resize-observer-browser@0.1.11': {}

  '@types/supercluster@7.1.3':
    dependencies:
      '@types/geojson': 7946.0.16

  '@vitejs/plugin-vue@6.0.3(vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2))(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@rolldown/pluginutils': 1.0.0-beta.53
      vite: 7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2)
      vue: 3.5.25(typescript@5.9.3)

  '@volar/language-core@2.4.26':
    dependencies:
      '@volar/source-map': 2.4.26

  '@volar/source-map@2.4.26': {}

  '@volar/typescript@2.4.26':
    dependencies:
      '@volar/language-core': 2.4.26
      path-browserify: 1.0.1
      vscode-uri: 3.1.0

  '@vue/compiler-core@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/shared': 3.5.25
      entities: 4.5.0
      estree-walker: 2.0.2
      source-map-js: 1.2.1

  '@vue/compiler-dom@3.5.25':
    dependencies:
      '@vue/compiler-core': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/compiler-sfc@3.5.25':
    dependencies:
      '@babel/parser': 7.28.5
      '@vue/compiler-core': 3.5.25
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      estree-walker: 2.0.2
      magic-string: 0.30.21
      postcss: 8.5.6
      source-map-js: 1.2.1

  '@vue/compiler-ssr@3.5.25':
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/devtools-api@7.7.9':
    dependencies:
      '@vue/devtools-kit': 7.7.9

  '@vue/devtools-kit@7.7.9':
    dependencies:
      '@vue/devtools-shared': 7.7.9
      birpc: 2.9.0
      hookable: 5.5.3
      mitt: 3.0.1
      perfect-debounce: 1.0.0
      speakingurl: 14.0.1
      superjson: 2.2.6

  '@vue/devtools-shared@7.7.9':
    dependencies:
      rfdc: 1.4.1

  '@vue/language-core@3.1.8(typescript@5.9.3)':
    dependencies:
      '@volar/language-core': 2.4.26
      '@vue/compiler-dom': 3.5.25
      '@vue/shared': 3.5.25
      alien-signals: 3.1.1
      muggle-string: 0.4.1
      path-browserify: 1.0.1
      picomatch: 4.0.3
    optionalDependencies:
      typescript: 5.9.3

  '@vue/reactivity@3.5.25':
    dependencies:
      '@vue/shared': 3.5.25

  '@vue/runtime-core@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/shared': 3.5.25

  '@vue/runtime-dom@3.5.25':
    dependencies:
      '@vue/reactivity': 3.5.25
      '@vue/runtime-core': 3.5.25
      '@vue/shared': 3.5.25
      csstype: 3.2.3

  '@vue/server-renderer@3.5.25(vue@3.5.25(typescript@5.9.3))':
    dependencies:
      '@vue/compiler-ssr': 3.5.25
      '@vue/shared': 3.5.25
      vue: 3.5.25(typescript@5.9.3)

  '@vue/shared@3.5.25': {}

  '@vue/tsconfig@0.8.1(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3))':
    optionalDependencies:
      typescript: 5.9.3
      vue: 3.5.25(typescript@5.9.3)

  alien-signals@3.1.1: {}

  autoprefixer@10.4.23(postcss@8.5.6):
    dependencies:
      browserslist: 4.28.1
      caniuse-lite: 1.0.30001760
      fraction.js: 5.3.4
      picocolors: 1.1.1
      postcss: 8.5.6
      postcss-value-parser: 4.2.0

  baseline-browser-mapping@2.9.9: {}

  birpc@2.9.0: {}

  browserslist@4.28.1:
    dependencies:
      baseline-browser-mapping: 2.9.9
      caniuse-lite: 1.0.30001760
      electron-to-chromium: 1.5.267
      node-releases: 2.0.27
      update-browserslist-db: 1.2.3(browserslist@4.28.1)

  caniuse-lite@1.0.30001760: {}

  copy-anything@4.0.5:
    dependencies:
      is-what: 5.5.0

  csstype@3.2.3: {}

  date-fns-tz@2.0.1(date-fns@2.30.0):
    dependencies:
      date-fns: 2.30.0

  date-fns@2.30.0:
    dependencies:
      '@babel/runtime': 7.28.4

  detect-libc@2.1.2: {}

  earcut@3.0.2: {}

  electron-to-chromium@1.5.267: {}

  enhanced-resolve@5.18.4:
    dependencies:
      graceful-fs: 4.2.11
      tapable: 2.3.0

  entities@4.5.0: {}

  esbuild@0.27.2:
    optionalDependencies:
      '@esbuild/aix-ppc64': 0.27.2
      '@esbuild/android-arm': 0.27.2
      '@esbuild/android-arm64': 0.27.2
      '@esbuild/android-x64': 0.27.2
      '@esbuild/darwin-arm64': 0.27.2
      '@esbuild/darwin-x64': 0.27.2
      '@esbuild/freebsd-arm64': 0.27.2
      '@esbuild/freebsd-x64': 0.27.2
      '@esbuild/linux-arm': 0.27.2
      '@esbuild/linux-arm64': 0.27.2
      '@esbuild/linux-ia32': 0.27.2
      '@esbuild/linux-loong64': 0.27.2
      '@esbuild/linux-mips64el': 0.27.2
      '@esbuild/linux-ppc64': 0.27.2
      '@esbuild/linux-riscv64': 0.27.2
      '@esbuild/linux-s390x': 0.27.2
      '@esbuild/linux-x64': 0.27.2
      '@esbuild/netbsd-arm64': 0.27.2
      '@esbuild/netbsd-x64': 0.27.2
      '@esbuild/openbsd-arm64': 0.27.2
      '@esbuild/openbsd-x64': 0.27.2
      '@esbuild/openharmony-arm64': 0.27.2
      '@esbuild/sunos-x64': 0.27.2
      '@esbuild/win32-arm64': 0.27.2
      '@esbuild/win32-ia32': 0.27.2
      '@esbuild/win32-x64': 0.27.2

  escalade@3.2.0: {}

  estree-walker@2.0.2: {}

  fdir@6.5.0(picomatch@4.0.3):
    optionalDependencies:
      picomatch: 4.0.3

  fraction.js@5.3.4: {}

  fsevents@2.3.3:
    optional: true

  geojson-vt@4.0.2: {}

  get-stream@6.0.1: {}

  gl-matrix@3.4.4: {}

  graceful-fs@4.2.11: {}

  hookable@5.5.3: {}

  is-what@5.5.0: {}

  jiti@2.6.1: {}

  json-stringify-pretty-compact@4.0.0: {}

  kdbush@4.0.2: {}

  lightningcss-android-arm64@1.30.2:
    optional: true

  lightningcss-darwin-arm64@1.30.2:
    optional: true

  lightningcss-darwin-x64@1.30.2:
    optional: true

  lightningcss-freebsd-x64@1.30.2:
    optional: true

  lightningcss-linux-arm-gnueabihf@1.30.2:
    optional: true

  lightningcss-linux-arm64-gnu@1.30.2:
    optional: true

  lightningcss-linux-arm64-musl@1.30.2:
    optional: true

  lightningcss-linux-x64-gnu@1.30.2:
    optional: true

  lightningcss-linux-x64-musl@1.30.2:
    optional: true

  lightningcss-win32-arm64-msvc@1.30.2:
    optional: true

  lightningcss-win32-x64-msvc@1.30.2:
    optional: true

  lightningcss@1.30.2:
    dependencies:
      detect-libc: 2.1.2
    optionalDependencies:
      lightningcss-android-arm64: 1.30.2
      lightningcss-darwin-arm64: 1.30.2
      lightningcss-darwin-x64: 1.30.2
      lightningcss-freebsd-x64: 1.30.2
      lightningcss-linux-arm-gnueabihf: 1.30.2
      lightningcss-linux-arm64-gnu: 1.30.2
      lightningcss-linux-arm64-musl: 1.30.2
      lightningcss-linux-x64-gnu: 1.30.2
      lightningcss-linux-x64-musl: 1.30.2
      lightningcss-win32-arm64-msvc: 1.30.2
      lightningcss-win32-x64-msvc: 1.30.2

  lodash@4.17.21: {}

  magic-string@0.30.21:
    dependencies:
      '@jridgewell/sourcemap-codec': 1.5.5

  maplibre-gl@5.15.0:
    dependencies:
      '@mapbox/geojson-rewind': 0.5.2
      '@mapbox/jsonlint-lines-primitives': 2.0.2
      '@mapbox/point-geometry': 1.1.0
      '@mapbox/tiny-sdf': 2.0.7
      '@mapbox/unitbezier': 0.0.1
      '@mapbox/vector-tile': 2.0.4
      '@mapbox/whoots-js': 3.1.0
      '@maplibre/maplibre-gl-style-spec': 24.4.1
      '@maplibre/mlt': 1.1.2
      '@maplibre/vt-pbf': 4.2.0
      '@types/geojson': 7946.0.16
      '@types/geojson-vt': 3.2.5
      '@types/supercluster': 7.1.3
      earcut: 3.0.2
      geojson-vt: 4.0.2
      gl-matrix: 3.4.4
      kdbush: 4.0.2
      murmurhash-js: 1.0.0
      pbf: 4.0.1
      potpack: 2.1.0
      quickselect: 3.0.0
      supercluster: 8.0.1
      tinyqueue: 3.0.0

  minimist@1.2.8: {}

  mitt@3.0.1: {}

  muggle-string@0.4.1: {}

  murmurhash-js@1.0.0: {}

  nanoid@3.3.11: {}

  node-releases@2.0.27: {}

  path-browserify@1.0.1: {}

  pbf@4.0.1:
    dependencies:
      resolve-protobuf-schema: 2.1.0

  perfect-debounce@1.0.0: {}

  picocolors@1.1.1: {}

  picomatch@4.0.3: {}

  pinia@3.0.4(typescript@5.9.3)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@vue/devtools-api': 7.7.9
      vue: 3.5.25(typescript@5.9.3)
    optionalDependencies:
      typescript: 5.9.3

  postcss-value-parser@4.2.0: {}

  postcss@8.5.6:
    dependencies:
      nanoid: 3.3.11
      picocolors: 1.1.1
      source-map-js: 1.2.1

  potpack@2.1.0: {}

  protocol-buffers-schema@3.6.0: {}

  quickselect@3.0.0: {}

  resolve-protobuf-schema@2.1.0:
    dependencies:
      protocol-buffers-schema: 3.6.0

  rfdc@1.4.1: {}

  rollup@4.53.5:
    dependencies:
      '@types/estree': 1.0.8
    optionalDependencies:
      '@rollup/rollup-android-arm-eabi': 4.53.5
      '@rollup/rollup-android-arm64': 4.53.5
      '@rollup/rollup-darwin-arm64': 4.53.5
      '@rollup/rollup-darwin-x64': 4.53.5
      '@rollup/rollup-freebsd-arm64': 4.53.5
      '@rollup/rollup-freebsd-x64': 4.53.5
      '@rollup/rollup-linux-arm-gnueabihf': 4.53.5
      '@rollup/rollup-linux-arm-musleabihf': 4.53.5
      '@rollup/rollup-linux-arm64-gnu': 4.53.5
      '@rollup/rollup-linux-arm64-musl': 4.53.5
      '@rollup/rollup-linux-loong64-gnu': 4.53.5
      '@rollup/rollup-linux-ppc64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-gnu': 4.53.5
      '@rollup/rollup-linux-riscv64-musl': 4.53.5
      '@rollup/rollup-linux-s390x-gnu': 4.53.5
      '@rollup/rollup-linux-x64-gnu': 4.53.5
      '@rollup/rollup-linux-x64-musl': 4.53.5
      '@rollup/rollup-openharmony-arm64': 4.53.5
      '@rollup/rollup-win32-arm64-msvc': 4.53.5
      '@rollup/rollup-win32-ia32-msvc': 4.53.5
      '@rollup/rollup-win32-x64-gnu': 4.53.5
      '@rollup/rollup-win32-x64-msvc': 4.53.5
      fsevents: 2.3.3

  rw@1.3.3: {}

  source-map-js@1.2.1: {}

  speakingurl@14.0.1: {}

  supercluster@8.0.1:
    dependencies:
      kdbush: 4.0.2

  superjson@2.2.6:
    dependencies:
      copy-anything: 4.0.5

  tailwindcss@4.1.18: {}

  tapable@2.3.0: {}

  tinyglobby@0.2.15:
    dependencies:
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3

  tinyqueue@3.0.0: {}

  typescript@5.9.3: {}

  undici-types@7.16.0: {}

  update-browserslist-db@1.2.3(browserslist@4.28.1):
    dependencies:
      browserslist: 4.28.1
      escalade: 3.2.0
      picocolors: 1.1.1

  v-calendar@3.1.2(@popperjs/core@2.11.8)(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      '@popperjs/core': 2.11.8
      '@types/lodash': 4.17.21
      '@types/resize-observer-browser': 0.1.11
      date-fns: 2.30.0
      date-fns-tz: 2.0.1(date-fns@2.30.0)
      lodash: 4.17.21
      vue: 3.5.25(typescript@5.9.3)
      vue-screen-utils: 1.0.0-beta.13(vue@3.5.25(typescript@5.9.3))

  vite@7.3.0(@types/node@24.10.4)(jiti@2.6.1)(lightningcss@1.30.2):
    dependencies:
      esbuild: 0.27.2
      fdir: 6.5.0(picomatch@4.0.3)
      picomatch: 4.0.3
      postcss: 8.5.6
      rollup: 4.53.5
      tinyglobby: 0.2.15
    optionalDependencies:
      '@types/node': 24.10.4
      fsevents: 2.3.3
      jiti: 2.6.1
      lightningcss: 1.30.2

  vscode-uri@3.1.0: {}

  vue-screen-utils@1.0.0-beta.13(vue@3.5.25(typescript@5.9.3)):
    dependencies:
      vue: 3.5.25(typescript@5.9.3)

  vue-tsc@3.1.8(typescript@5.9.3):
    dependencies:
      '@volar/typescript': 2.4.26
      '@vue/language-core': 3.1.8(typescript@5.9.3)
      typescript: 5.9.3

  vue@3.5.25(typescript@5.9.3):
    dependencies:
      '@vue/compiler-dom': 3.5.25
      '@vue/compiler-sfc': 3.5.25
      '@vue/runtime-dom': 3.5.25
      '@vue/server-renderer': 3.5.25(vue@3.5.25(typescript@5.9.3))
      '@vue/shared': 3.5.25
    optionalDependencies:
      typescript: 5.9.3

```

## pnpm-workspace.yaml

```yaml
packages:
  - 'frontend'

```

## project_export.log

```text
[2025-12-23 22:20:08] Source  : .
[2025-12-23 22:20:08] Sortie  : project_export.md
[2025-12-23 22:20:08] Fichiers trouvés (avant filtre): 14764
[2025-12-23 22:20:08] Fichiers à concaténer (après filtre): 57 (exclus auto:2 dir:14705 file:0)
[2025-12-23 22:20:08] Concatène [1] .github/workflows/pull_request.yml (size=883)
[2025-12-23 22:20:08] Concatène [2] .github/workflows/release.yml (size=2609)
[2025-12-23 22:20:08] Concatène [3] .gitignore (size=282)
[2025-12-23 22:20:08] Concatène [4] Dockerfile (size=2895)
[2025-12-23 22:20:08] Concatène [5] Makefile (size=3963)
[2025-12-23 22:20:08] Concatène [6] backend/.air.toml (size=598)
[2025-12-23 22:20:08] Concatène [7] backend/Dockerfile (size=2895)
[2025-12-23 22:20:08] Concatène [8] backend/Makefile (size=3247)
[2025-12-23 22:20:08] Concatène [9] backend/api/handlers.go (size=4301)
[2025-12-23 22:20:08] Concatène [10] backend/cmd/server/main.go (size=1086)
[2025-12-23 22:20:08] Concatène [11] backend/go.mod (size=794)
[2025-12-23 22:20:08] Concatène [12] backend/go.sum (size=3296)
[2025-12-23 22:20:08] Concatène [13] backend/internal/database/db.go (size=853)
[2025-12-23 22:20:08] Concatène [14] backend/internal/handlers/epic_handler.go (size=2472)
[2025-12-23 22:20:08] Concatène [15] backend/internal/handlers/item_handler.go (size=2480)
[2025-12-23 22:20:08] Concatène [16] backend/internal/models/epic.go (size=781)
[2025-12-23 22:20:08] Concatène [17] backend/internal/models/item.go (size=983)
[2025-12-23 22:20:08] Concatène [18] backend/internal/router/router.go (size=2361)
[2025-12-23 22:20:08] ℹ️  Binaire : backend/klaro.db — référencé mais non inclus
[2025-12-23 22:20:08] Concatène [20] backend/package.json (size=255)
[2025-12-23 22:20:08] Concatène [21] backend/plan (size=4170)
[2025-12-23 22:20:08] Concatène [22] backend/pnpm-lock.yaml (size=49940)
[2025-12-23 22:20:08] Concatène [23] backend/pnpm-workspace.yaml (size=39)
[2025-12-23 22:20:08] Concatène [24] backend/project_export.log (size=3930)
[2025-12-23 22:20:08] Concatène [25] backend/project_export.md (size=190621)
[2025-12-23 22:20:08] Concatène [26] backend/san_dir.txt (size=22)
[2025-12-23 22:20:08] Concatène [27] backend/san_file.txt (size=29)
[2025-12-23 22:20:08] Concatène [28] backend/store/schema.go (size=2835)
[2025-12-23 22:20:08] Concatène [29] backend/tmp/build-errors.log (size=78)
[2025-12-23 22:20:08] ℹ️  Binaire : backend/tmp/main — référencé mais non inclus
[2025-12-23 22:20:08] Concatène [31] documentation/RELEASE_PROCESS.md (size=5637)
[2025-12-23 22:20:08] Concatène [32] frontend/.gitignore (size=253)
[2025-12-23 22:20:08] Concatène [33] frontend/.vscode/extensions.json (size=39)
[2025-12-23 22:20:08] Concatène [34] frontend/README.md (size=442)
[2025-12-23 22:20:08] Concatène [35] frontend/index.html (size=617)
[2025-12-23 22:20:08] Concatène [36] frontend/package.json (size=679)
[2025-12-23 22:20:08] Concatène [37] frontend/pnpm-lock.yaml (size=29270)
[2025-12-23 22:20:08] Concatène [38] frontend/public/vite.svg (size=1497)
[2025-12-23 22:20:08] Concatène [39] frontend/src/App.vue (size=2156)
[2025-12-23 22:20:08] Concatène [40] frontend/src/assets/vue.svg (size=496)
[2025-12-23 22:20:08] Concatène [41] frontend/src/components/HelloWorld.vue (size=856)
[2025-12-23 22:20:08] Concatène [42] frontend/src/main.ts (size=495)
[2025-12-23 22:20:08] Concatène [43] frontend/src/stores/kadastro.ts (size=7365)
[2025-12-23 22:20:08] Concatène [44] frontend/src/style.css (size=3598)
[2025-12-23 22:20:08] Concatène [45] frontend/tsconfig.app.json (size=454)
[2025-12-23 22:20:08] Concatène [46] frontend/tsconfig.json (size=119)
[2025-12-23 22:20:08] Concatène [47] frontend/tsconfig.node.json (size=653)
[2025-12-23 22:20:08] Concatène [48] frontend/vite.config.ts (size=213)
[2025-12-23 22:20:08] Concatène [49] k8s/deployment.yaml (size=1223)
[2025-12-23 22:20:08] Concatène [50] k8s/ingress.yaml (size=608)
[2025-12-23 22:20:08] Concatène [51] k8s/service.yaml (size=170)
[2025-12-23 22:20:08] Concatène [52] package.json (size=255)
[2025-12-23 22:20:08] Concatène [53] plan (size=4170)
[2025-12-23 22:20:08] Concatène [54] pnpm-lock.yaml (size=57280)
[2025-12-23 22:20:08] Concatène [55] pnpm-workspace.yaml (size=25)

```

## san_file.txt

```text
project_export.md
*.svg
*.log
```

