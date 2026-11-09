variable "region" {
  type    = string
  default = "us-west-2"
}

variable "name" {
  description = "Prefix for every resource name"
  type        = string
  default     = "gofundme-engage"
}

variable "image_tag" {
  description = "Tag of the app image in ECR"
  type        = string
  default     = "latest"
}

variable "web_min_tasks" {
  type    = number
  default = 2
}

variable "web_max_tasks" {
  type    = number
  default = 10
}

variable "aurora_max_acu" {
  description = "Upper bound for Aurora Serverless v2 capacity"
  type        = number
  default     = 8
}

variable "admin_key" {
  description = "Value of the x-admin-key header that unlocks /api/v1/metrics/engagement"
  type        = string
  sensitive   = true
}
