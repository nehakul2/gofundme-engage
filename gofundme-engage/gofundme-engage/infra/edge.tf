# Cache policies. TTLs come from the origin's Cache-Control (s-maxage), clamped to min and max.
resource "aws_cloudfront_cache_policy" "no_cache" {
  name        = "${var.name}-no-cache"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 0
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# Live numbers: the app says s-maxage=2 (stats) and 5 (supporters); never cache longer than 30 s
resource "aws_cloudfront_cache_policy" "live_reads" {
  name        = "${var.name}-live-reads"
  min_ttl     = 0
  default_ttl = 2
  max_ttl     = 30
  parameters_in_cache_key_and_forwarded_to_origin {
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "all"
    }
  }
}

resource "aws_cloudfront_origin_request_policy" "forward_viewer" {
  name = "${var.name}-forward-viewer"
  cookies_config {
    cookie_behavior = "none"
  }
  headers_config {
    header_behavior = "allViewer"
  }
  query_strings_config {
    query_string_behavior = "all"
  }
}

resource "aws_cloudfront_distribution" "main" {
  enabled     = true
  comment     = var.name
  price_class = "PriceClass_100"

  origin {
    origin_id   = "alb"
    domain_name = aws_lb.main.dns_name
    custom_origin_config {
      http_port                = 80
      https_port               = 443
      origin_protocol_policy   = "http-only"
      origin_ssl_protocols     = ["TLSv1.2"]
      origin_read_timeout      = 60 # the pulse stream sends a keepalive every 15 s
      origin_keepalive_timeout = 60
    }
    custom_header {
      name  = "X-Origin-Verify"
      value = random_password.origin_verify.result
    }
  }

  # Supporters list and totals: cached for a few seconds, so a surge hits the edge, not the app
  ordered_cache_behavior {
    path_pattern             = "/api/v1/fundraisers/*/stats"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.live_reads.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.forward_viewer.id
    compress                 = true
  }

  ordered_cache_behavior {
    path_pattern             = "/api/v1/fundraisers/*/donations"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.live_reads.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.forward_viewer.id
    compress                 = true
  }

  # Server-Sent Events must not be cached or compressed
  ordered_cache_behavior {
    path_pattern             = "/api/v1/fundraisers/*/pulse"
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.no_cache.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.forward_viewer.id
    compress                 = false
  }

  # Everything else (pages, writes, viewer-specific calls) goes to the app uncached
  default_cache_behavior {
    target_origin_id         = "alb"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = aws_cloudfront_cache_policy.no_cache.id
    origin_request_policy_id = aws_cloudfront_origin_request_policy.forward_viewer.id
    compress                 = true
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
