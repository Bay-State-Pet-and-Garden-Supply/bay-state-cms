# Bay State CMS

A standalone local content management system for ShopSite stores.

> **Generic tool — works with any ShopSite store.**
> Not specific to any merchant or retailer.

## Overview

Bay State CMS is a local web application that provides modern product management capabilities for ShopSite e-commerce stores. It uses Git as canonical storage for approved catalog state, SQLite for local operational state, and syncs product changes to ShopSite stores.

## Architecture

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + Vite SPA | Modern product management UI |
| API Server | Bun + Hono | Local HTTP API |
| Database | SQLite via `bun:sqlite` | Drafts, indexing, sync state, logs |
| Storage | Git (installed CLI) | Version-controlled approved catalog |
| Adapter | Generic ShopSite CGI | Product XML download/upload |

## Quick Start

```bash
# Prerequisites:
# - Bun 1.3.5+
# - Git CLI installed

# Install dependencies
bun install

# Start dev server (API + Vite)
bun run dev
```

The dev script starts both:
1. API server on `http://localhost:3030`
2. Vite dev server on `http://localhost:5173`

## Scripts

```bash
bun run dev         # Start development (API + Vite)
bun run build       # Build production frontend
bun run test        # Run all tests
bun run typecheck   # TypeScript check
bun run lint        # ESLint
```

## V1 Scope

- Workspace creation and ShopSite connection
- Bootstrap product catalog from ShopSite
- Detail-first product editing with draft change sets
- Validation with strict blockers and warnings
- Change set approval and Git commit
- Direct Push & Publish to ShopSite (Basic auth)
- Export package fallback for manual upload
- Drift detection and explicit reconciliation
- **Spreadsheet-style Bulk Onboarding Pipeline:**
  - Fast, multi-pass brand source page discovery.
  - Multi-threaded playwright/crawlee product scraper (price, description, images, weights).
  - **Local VLM OCR Packaging Alignment:** Uses local vision models (e.g. Qwen2.5-VL) to extract package titles from product photos and synthesize clean customer-facing store names.
  - **Automated Taxonomy Classification:** Assigns store page category links and classifies items into store product types.
  - Interactive approval queue and change-set draft promoter.

## ShopSite Integration Notes

- Uses documented `db_xml.cgi`, `dbupload.cgi`, `dbmake.cgi`, and `generate.cgi` endpoints
- Authentication is environment-specific; Basic auth is the v1 default adapter
- Export fallback mode is always available when direct sync is not viable
- The full ShopSite XML schema is not exhaustively published; unknown fields are preserved as-is

## Roadmap

- Full page CMS (requires store-provided page XML sample)
- Multi-store workspace switcher
- Git remote backup and PR-style review
- Local media library with store upload adapters
- OS keychain credential storage
- Rich admin panel with branch/commit visibility
