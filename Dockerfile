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