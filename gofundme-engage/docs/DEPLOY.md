# Deploying to AWS

Status: **written but not applied.** I had no AWS account access, and the OpenTofu registry
was blocked in my sandbox, so `infra/` was only checked for HCL syntax and formatting
(`tofu fmt`), not validated against the AWS provider. Expect to fix a few small things on
the first `plan`. The Dockerfile was also not built (no Docker daemon).

## What gets created

| Piece | Service | Notes |
|---|---|---|
| Edge | CloudFront | Caches `/stats` (2 s) and the supporters list (5 s) at the edge; pulse stream and everything else uncached |
| App | ECS Fargate, 2 to 10 tasks | Autoscales at 60% CPU; behind an ALB that only accepts CloudFront's secret header |
| Worker | ECS Fargate, 1 task | Runs the outbox relay, counters, milestones, 24 h payment verification |
| Database | Aurora PostgreSQL 16 Serverless v2 | 0.5 to 8 ACU, encrypted |
| Counters | ElastiCache Redis 7, 1 node | No replica yet |
| Secrets | Secrets Manager | Database URL, Redis URL, webhook secret, admin key |

Not created yet: SQS FIFO (the worker uses the in-process queue, so keep it at one task),
RDS Proxy, Kinesis/Athena analytics, a custom domain and certificate, alarms.

## Steps

```bash
cd infra
export TF_VAR_admin_key='choose-a-long-random-string'
tofu init
tofu apply -target=aws_ecr_repository.app          # the repository must exist before the image
REPO=$(tofu output -raw ecr_repository)
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}"
docker build -t "$REPO:latest" .. && docker push "$REPO:latest"
tofu apply                                          # everything else, about 15 minutes (Aurora and CloudFront)
$(tofu output -raw migrate_command)                 # run migrations once
tofu output site_url
```

To load the demo fixtures, run the same task with the command overridden to `npm run seed`
(`--overrides` on `aws ecs run-task`). The seed wipes existing data, so do it only on a demo environment.

Redeploy: build and push a new tag, `tofu apply -var image_tag=<tag>`, then run the migrate task if the release has migrations.

## Load test against the deployed site

```bash
k6 run -e BASE_URL=$(tofu output -raw site_url) -e READERS=500 -e DONATION_RATE=100 load/k6-fundraiser.js
```
Then run `npm run load:check` from a task or machine that can reach the database.

## Known gaps before real traffic

- One NAT gateway and one Redis node are single points of failure.
- The mock payment provider is still wired in.
- Database TLS uses `sslmode=no-verify`; bundle the RDS CA to verify the certificate.
- `skip_final_snapshot = true` on Aurora is a demo setting.
