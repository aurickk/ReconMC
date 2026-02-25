#!/bin/sh
set -e

# Default API_URL if not set
: "${API_URL:=http://coordinator:3000}"

# Substitute environment variables in nginx config template
envsubst '${API_URL}' < /etc/nginx/conf.d/default.conf.template > /etc/nginx/conf.d/default.conf

echo "Dashboard starting with API_URL: ${API_URL}"

# Start nginx
exec nginx -g 'daemon off;'
