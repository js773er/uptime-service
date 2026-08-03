# uptime-service

A uptime monitoring service I built. Add a URL and it gets checked every minute from Sydney. If the site goes down, you receive an email notification. Each monitor also has a public status page that can be shared.

> **Demo:** Coming soon  
> **Stack:** Next.js, TypeScript, DynamoDB, AWS Lambda, EventBridge, SQS, CDK, Clerk, Resend

---

## Features

- Check websites every minute
- Email alerts when a site first goes offline
- Public status pages
- Pause and resume monitors
- Automatic incident tracking
- 30-day history of uptime checks
- Serverless AWS architecture
- Infrastructure defined with AWS CDK

---

## Architecture

Every minute, EventBridge invokes the checker Lambda. The checker queries DynamoDB for active monitors, requests each URL with a 10-second timeout, and stores the result.

If a monitor changes from **up** to **down**, the checker creates an incident and sends a message to SQS. A second Lambda processes the queue and sends an email through Resend. Failed deliveries are retried automatically before eventually moving to a dead-letter queue.

The frontend is built with **Next.js App Router** and **Clerk** for authentication.

Pages that only read data use Server Components and access DynamoDB directly. Actions such as creating, deleting or pausing monitors go through API routes, with request validation handled by Zod.

Public status pages are cached for 60 seconds since new check results only arrive once per minute.

Alerts are edge-triggered, meaning users receive one email when a site goes down instead of repeated notifications every minute.

---

## Data Model

The application stores everything in a single DynamoDB table.

| Entity | Partition Key | Sort Key |
|---------|---------------|----------|
| Monitor | `USER#<userId>` | `MONITOR#<monitorId>` |
| Check Result | `MONITOR#<monitorId>` | `CHECK#<timestamp>` |
| Incident | `MONITOR#<monitorId>` | `INCIDENT#OPEN` or `INCIDENT#<startedAt>#<id>` |

Two GSIs support the main access patterns.

### GSI1

Contains only active monitors, allowing the checker to query monitors without scanning the table.

### GSI2

Allows public status pages to find monitors by monitor ID.

---

## Design Decisions

A few implementation details that helped make the system more reliable:

- Open incidents always use the same sort key and are created with a conditional write, preventing duplicate incidents if two checker executions overlap.
- The free plan's five-monitor limit is enforced using a counter item updated within the same DynamoDB transaction as monitor creation, preventing race conditions.
- Check results automatically expire after 30 days using DynamoDB TTL.

For security, only public HTTPS URLs are accepted.

The application rejects:

- localhost
- private IP ranges
- link-local addresses
- cloud metadata endpoints

The checker also performs DNS resolution before every request rather than trusting the hostname resolved during monitor creation, helping protect against DNS rebinding attacks.

---

## Local Development

### Requirements

- Node.js 22+
- AWS account
- Clerk account
- Resend account

Install dependencies:

```bash
npm ci
```

Copy the environment file:

```bash
cp .env.example .env.local
```

Fill in the required environment variables.

Start the development server:

```bash
npm run dev
```

---

## Testing

Run all tests:

```bash
npm test
```

Type checking:

```bash
npm run typecheck
```

Linting:

```bash
npm run lint
```

---

## Deployment

Bootstrap your AWS account once:

```bash
npx cdk bootstrap
```

Deploy the infrastructure:

```bash
npm run deploy
```

The deployment outputs the DynamoDB table name.

Add the following values to your Vercel project before deploying the frontend:

- AWS credentials
- Clerk credentials
- `TABLE_NAME`

---

## Environment Variables

See `.env.example` for the complete list.

The main variables are:

### Web App

```
CLERK_*
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION
TABLE_NAME
```

### Alert Lambda

```
RESEND_API_KEY
ALERT_FROM_EMAIL
ALERT_FALLBACK_EMAIL
```

These values are injected into the Lambda during deployment.

---

## Project Structure

```
.
├── app/                 # Next.js App Router
├── components/
├── lib/
├── lambda/
│   ├── checker/
│   └── alert/
├── cdk/
├── public/
├── tests/
└── DECISIONS.md
```

---

## Future Improvements

Some features I'd like to add:

- Multi-region monitoring
- Discord and Slack notifications
- SMS alerts
- SSL certificate expiry monitoring
- Content verification
- Response time graphs
- Custom check intervals
- Better analytics

---


## Notes

I kept a running development log in `DECISIONS.md` documenting major implementation decisions, trade-offs, and fixes made during development, including several race conditions and validation issues discovered during a final review before deployment.