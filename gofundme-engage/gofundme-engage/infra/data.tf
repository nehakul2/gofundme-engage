resource "random_password" "db" {
  length  = 32
  special = false
}

resource "random_password" "webhook" {
  length  = 40
  special = false
}

resource "random_password" "origin_verify" {
  length  = 40
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

# Aurora PostgreSQL: the donation ledger and all relational data
resource "aws_rds_cluster" "main" {
  cluster_identifier     = var.name
  engine                 = "aurora-postgresql"
  engine_version         = "16.4"
  database_name          = "gofundme"
  master_username        = "app"
  master_password        = random_password.db.result
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  storage_encrypted      = true
  skip_final_snapshot    = true # demo setting: set false and name a final snapshot for real use

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = var.aurora_max_acu
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier         = "${var.name}-writer"
  cluster_identifier = aws_rds_cluster.main.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.main.engine
  engine_version     = aws_rds_cluster.main.engine_version
}

# ElastiCache Redis: live counters, event dedupe and the pulse list
resource "aws_elasticache_subnet_group" "main" {
  name       = var.name
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = var.name
  description          = "Live counters for ${var.name}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = "cache.t4g.small"
  num_cache_clusters   = 1 # add a replica and automatic failover for production
  port                 = 6379
  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
}

# sslmode=no-verify: encrypted, but the RDS CA is not in Node's trust store. Bundle the RDS CA to verify fully.
resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.name}/app"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    DATABASE_URL   = "postgres://app:${random_password.db.result}@${aws_rds_cluster.main.endpoint}:5432/gofundme?sslmode=no-verify"
    REDIS_URL      = "redis://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379"
    WEBHOOK_SECRET = random_password.webhook.result
    ADMIN_KEY      = var.admin_key
  })
}
