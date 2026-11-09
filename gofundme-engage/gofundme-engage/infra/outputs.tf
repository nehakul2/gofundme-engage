output "site_url" {
  value = "https://${aws_cloudfront_distribution.main.domain_name}"
}

output "ecr_repository" {
  value = aws_ecr_repository.app.repository_url
}

output "migrate_command" {
  description = "Run once per release, after the image is pushed"
  value       = "aws ecs run-task --region ${var.region} --cluster ${aws_ecs_cluster.main.name} --launch-type FARGATE --task-definition ${aws_ecs_task_definition.migrate.family} --network-configuration 'awsvpcConfiguration={subnets=[${join(",", aws_subnet.private[*].id)}],securityGroups=[${aws_security_group.app.id}]}'"
}
