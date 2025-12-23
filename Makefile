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