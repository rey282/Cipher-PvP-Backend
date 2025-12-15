# Cipher PvP — Backend System Authority

This repository contains the **Cipher PvP backend**, the authoritative system responsible for authentication, data persistence, rule enforcement, draft lifecycle management, and administrative safety across the Cipher competitive PvP ecosystem.

Unlike the frontend, the backend is a **stateful, authoritative service**.
All critical logic, validation, and enforcement occur here.

---

## System Context

Cipher PvP is a multi-service system composed of:
1. **Frontend** — UI, visualization, user interaction
2. **Backend (this repo)** — Authentication, data persistence, rule enforcement, drafts, and administrative safety
3. **Discord Bot** — Match ingestion, ELO processing, historical data creation

This repository represents the **system authority layer**.

---

## Core Responsibilities

The backend owns and enforces:

- Discord OAuth authentication
- Session management and identity
- Database access and seasonal data partitioning
- Match history and player statistics
- Draft session lifecycle (HSR & ZZZ)
- Spectator streaming via Server-Sent Events (SSE)
- Balance and cost systems
- Administrative permissions and rollback safety
- Rate limiting and abuse protection

No client is trusted to enforce rules.

---

## Authentication & Identity

### OAuth Authority
- Discord OAuth is implemented **exclusively** in the backend
- Frontend and other clients never handle OAuth tokens
- Identity is established once and shared across services

### Sessions
- Sessions are stored in the database
- Session cookies are scoped to a shared domain
- All authenticated requests rely on session presence

### Identity Guarantees
- Each request resolves to:
  - an authenticated user, or
  - an anonymous user
- Admin status is resolved server-side
- Clients cannot self-assign privileges

---

## Data Ownership & Persistence

The backend is the **single source of truth** for all persistent data.

### Owned Data Domains
- Players and profiles
- Matches and outcomes
- Character statistics
- Seasonal and historical partitions
- Balance and cost values
- Draft session state
- Administrative audit logs

No authoritative data is stored client-side.

---

## Seasons, Cycles & Aggregation

### Seasons
- Player and match data is partitioned by season
- Each season maps to dedicated database tables
- Seasons are defined centrally and enforced consistently

### Cycles
- Character statistics are partitioned by balance cycle
- Each cycle represents a discrete balance window
- Historical cycles remain queryable

### Aggregation
- All-time views are computed dynamically
- Aggregation logic is centralized
- Clients cannot alter aggregation behavior

This ensures historical accuracy and balance transparency.

---

## Draft System Authority

Drafts are modeled as **stateful backend-managed sessions**.

### Supported Drafts
- Honkai: Star Rail (HSR)
- Zenless Zone Zero (ZZZ)

### Backend Responsibilities
- Draft creation and ownership
- Turn order enforcement
- Pick / ban / ace validation
- Penalty calculation
- Action authorization
- Session persistence

### Spectator Streaming
- Draft updates are emitted via **Server-Sent Events (SSE)**
- Spectators receive real-time state updates
- No polling or reconstruction is required client-side

The backend is the sole authority on draft legality.

---

## Balance & Cost Systems

The backend maintains multiple balance domains:

- **Cipher** — HSR primary format
- **Cerydra** — HSR alternate format
- **Vivian** — ZZZ format

### Responsibilities
- Store balance values
- Validate administrative updates
- Expose public balance views
- Maintain historical integrity

Client-side tools may simulate costs, but enforcement occurs here.

---

## Administrative Safety Model

Administrative actions are treated as **high-risk operations**.

### Admin Authority
- Admin users are defined server-side
- Privileges are resolved on every request
- UI checks are never trusted

### Admin Capabilities
- Match rollback
- Match refresh
- Balance updates
- Roster auditing

### Safety Guarantees
- Rollbacks are explicit and scoped
- All admin actions are validated
- Auditability is preserved

This design prioritizes system integrity over convenience.

---

## Rate Limiting & Abuse Protection

The backend applies layered protections:

- Global rate limits for public endpoints
- Stricter limits for state-mutating actions
- Draft interaction limits separated by role
- Streaming endpoints excluded from mutation limits

This protects system availability without harming live drafts.

---

## Authority Boundaries

### The backend:
- Enforces all rules
- Validates all mutations
- Owns all persistent state
- Resolves identity and permissions
- Aggregates historical data

### The backend does NOT:
- Render UI
- Store presentation state
- Assume client correctness
- Delegate authority to external services

All clients are treated as untrusted.

---

## System Positioning

This backend exists to:
- Guarantee competitive integrity
- Preserve historical accuracy
- Provide secure, auditable administration
- Coordinate multiple client surfaces safely

It is intentionally strict, explicit, and authoritative.

---

## Related Systems

Cipher PvP operates as a coordinated ecosystem:

- **Frontend Web Client** — Presentation layer
- **Discord Bot** — Match ingestion and automation

This repository defines the **rules and reality** those systems depend on.
