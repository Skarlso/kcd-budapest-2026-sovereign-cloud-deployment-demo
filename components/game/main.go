package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed web
var webFS embed.FS

var version = "dev"

const schema = `CREATE TABLE IF NOT EXISTS scores (
	id         BIGSERIAL PRIMARY KEY,
	name       TEXT NOT NULL,
	score      INTEGER NOT NULL,
	version    TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`

type server struct {
	pool    *pgxpool.Pool
	dbReady atomic.Bool
	version string
	image   string
	pod     string
	config  json.RawMessage
}

type score struct {
	Name      string    `json:"name"`
	Score     int       `json:"score"`
	Version   string    `json:"version"`
	CreatedAt time.Time `json:"createdAt"`
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	s := &server{
		version: envOr("APP_VERSION", version),
		image:   os.Getenv("IMAGE_REF"),
		pod:     os.Getenv("POD_NAME"),
		config:  gameConfig(),
	}

	if dsn := os.Getenv("DATABASE_URL"); dsn != "" {
		pool, err := pgxpool.New(ctx, dsn)
		if err != nil {
			log.Fatalf("invalid DATABASE_URL: %v", err)
		}
		defer pool.Close()
		s.pool = pool
		// Game comes up faster than, the database, so keep trying.
		go s.migrate(ctx)
	} else {
		log.Print("DATABASE_URL not set, high scores are disabled")
	}

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET /", http.FileServerFS(static))
	mux.HandleFunc("GET /api/info", s.handleInfo)
	mux.HandleFunc("GET /api/scores", s.listScores)
	mux.HandleFunc("POST /api/scores", s.addScore)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })

	srv := &http.Server{
		Addr:              ":" + envOr("PORT", "8080"),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()

	log.Printf("asteroid run %s listening on %s", s.version, srv.Addr)
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func (s *server) migrate(ctx context.Context) {
	for attempt := 1; ; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		_, err := s.pool.Exec(attemptCtx, schema)
		cancel()
		if err == nil {
			s.dbReady.Store(true)
			log.Printf("database ready after %d attempt(s)", attempt)
			return
		}
		log.Printf("database not ready (attempt %d): %v", attempt, err)

		select {
		case <-ctx.Done():
			return
		case <-time.After(2 * time.Second):
		}
	}
}

func (s *server) handleInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":  s.version,
		"image":    s.image,
		"pod":      s.pod,
		"config":   s.config,
		"database": s.dbReady.Load(),
	})
}

func (s *server) listScores(w http.ResponseWriter, r *http.Request) {
	if !s.dbReady.Load() {
		writeError(w, http.StatusServiceUnavailable, "database not ready")
		return
	}

	rows, err := s.pool.Query(r.Context(),
		`SELECT name, score, version, created_at FROM scores ORDER BY score DESC, created_at ASC LIMIT 10`)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	defer rows.Close()

	scores := []score{}
	for rows.Next() {
		var sc score
		if err := rows.Scan(&sc.Name, &sc.Score, &sc.Version, &sc.CreatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		scores = append(scores, sc)
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, scores)
}

func (s *server) addScore(w http.ResponseWriter, r *http.Request) {
	if !s.dbReady.Load() {
		writeError(w, http.StatusServiceUnavailable, "database not ready")
		return
	}

	var in struct {
		Name  string `json:"name"`
		Score int    `json:"score"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if n := utf8.RuneCountInString(in.Name); n == 0 || n > 12 {
		writeError(w, http.StatusBadRequest, "name must be 1 to 12 characters")
		return
	}
	if in.Score < 0 || in.Score > 10_000_000 {
		writeError(w, http.StatusBadRequest, "score out of range")
		return
	}

	if _, err := s.pool.Exec(r.Context(),
		`INSERT INTO scores (name, score, version) VALUES ($1, $2, $3)`, in.Name, in.Score, s.version); err != nil {
		writeError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"status": "saved"})
}

// gameConfig returns the chart's game values, rendered into GAME_CONFIG as JSON.
func gameConfig() json.RawMessage {
	raw := os.Getenv("GAME_CONFIG")
	if raw == "" || !json.Valid([]byte(raw)) {
		return json.RawMessage("null")
	}
	return json.RawMessage(raw)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
