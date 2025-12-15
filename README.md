# Cipher PvP — Backend System

This repository contains the **Cipher PvP backend**, which acts as the central authority for authentication, data storage, rule enforcement, drafts, and administrative operations across the Cipher PvP ecosystem.

The backend is a **stateful service** and the **single source of truth** for the system.  
All validation, enforcement, and persistence happen here.

---

## System Context

Cipher PvP is a multi-service system composed of:

1. **Frontend** — UI, data presentation, and user interaction  
2. **Backend (this repo)** — Authentication, persistence, rules, drafts, and admin controls  
3. **Discord Bot** — Match ingestion, ELO updates, and historical data creation  

This repository represents the **system authority layer**.

---

## Core Responsibilities

The backend is responsible for:

- Discord OAuth authentication
- Session and identity management
- Database access and seasonal partitioning
- Match history and player statistics
- Draft lifecycle management (HSR & ZZZ)
- Real-time draft updates via Server-Sent Events (SSE)
- Balance and cost data
- Administrative actions and rollback safety
- Rate limiting and abuse protection

Clients are not trusted to enforce rules.

---

## Authentication & Identity

### OAuth
- Discord OAuth is implemented only in the backend
- Frontend and other clients never handle OAuth tokens
- Authentication state is shared through server-managed sessions

### Sessions
- Sessions are stored in the database
- Cookies are scoped to a shared domain
- All protected endpoints rely on session presence

### Identity Guarantees
- Each request resolves to either:
  - an authenticated user, or
  - an anonymous user
- Admin status is determined server-side
- Clients cannot grant themselves elevated privileges

---

## Data Ownership & Persistence

The backend is the **single source of truth** for all persistent data.

### Data managed by the backend
- Player accounts and profiles
- Match records and results
- Character statistics
- Seasonal and historical datasets
- Balance and cost values
- Draft session state
- Administrative audit data

No authoritative data is stored or trusted client-side.

---

## Seasons, Cycles & Aggregation

### Seasons
- Player and match data is split into seasonal tables
- Each season maps to a specific set of database tables
- Season boundaries are defined and enforced centrally

### Cycles
- Character statistics are tracked per balance cycle
- Each cycle represents a specific balance window
- Historical cycles remain accessible for comparison

### Aggregation
- All-time views are computed dynamically
- Aggregation logic lives entirely in the backend
- Clients cannot influence aggregation behavior

This keeps historical data consistent and reliable.

---

## Draft System Authority

Drafts are handled as **backend-managed sessions**.

### Supported Draft Types
- Honkai: Star Rail (HSR)
- Zenless Zone Zero (ZZZ)

### Backend Responsibilities
- Creating and managing draft sessions
- Enforcing turn order
- Validating picks, bans, and aces
- Calculating penalties
- Authorizing player actions
- Persisting draft state

### Spectator Streaming
- Draft updates are pushed using **Server-Sent Events (SSE)**
- Spectators receive live state updates
- No client-side polling or reconstruction is required

The backend is the only authority on draft legality.

---

## Balance & Cost Systems

The backend maintains balance data for multiple formats:

- **Cipher** — HSR main format
- **Cerydra** — HSR alternate format
- **Vivian** — ZZZ format

### Responsibilities
- Store and version balance values
- Validate administrative balance changes
- Expose public balance data
- Preserve historical integrity

Client tools may simulate costs, but final validation happens here.

---

## Administrative Safety Model

Administrative actions are treated as sensitive operations.

### Admin Authority
- Admin users are defined server-side
- Privileges are resolved on every request
- UI checks are for convenience only

### Admin Capabilities
- Match rollbacks
- Match refreshes
- Balance updates
- Roster audits

### Safety Measures
- Rollbacks are explicit and scoped
- All admin actions are validated
- Actions are auditable

System integrity is always prioritized over convenience.

---

## Rate Limiting & Abuse Protection

The backend applies multiple layers of protection:

- Global limits for public endpoints
- Stricter limits for state-changing operations
- Separate limits for draft interactions
- Streaming endpoints excluded from mutation limits

This helps protect availability without disrupting live drafts.

---

## Authority Boundaries

### The backend does:
- Enforce all rules
- Validate all state changes
- Own all persistent data
- Resolve identity and permissions
- Aggregate historical data

### The backend does not:
- Render UI
- Store presentation state
- Trust client-side validation
- Delegate authority to external services

All clients are treated as untrusted.

---

## System Positioning

This backend exists to:
- Protect competitive integrity
- Preserve accurate historical data
- Provide safe administrative tooling
- Coordinate multiple clients reliably

It is intentionally strict and explicit by design.

---

## Related Systems

Cipher PvP also includes:

- **Frontend Web Client** — User-facing interface  
- **Discord Bot** — Match ingestion and automation  

This repository defines the rules and data those systems depend on.

---

## License

This project is licensed under the **MIT License**.

This license applies to the backend implementation.  
Client applications are covered by their own licenses.
