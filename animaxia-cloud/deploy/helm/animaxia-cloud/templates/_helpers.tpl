{{/* =============================================================================
Animaxia Cloud — template helpers

Naming contract:
  - Shared resources (config/secret/pvc/sa/ingress/cronjobs): "<fullname>-…"
  - Deployments/Services: FIXED "<key>-service" names (in-cluster DNS used by
    the env.config *SERVICEURL entries, e.g. http://auth-service:4001).
============================================================================= */}}

{{- define "animaxia.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "animaxia.fullname" -}}
{{- if .Values.global.fullnameOverride -}}
{{- .Values.global.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* chart name + version label */}}
{{- define "animaxia.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* target namespace (global.namespaceOverride → release namespace) */}}
{{- define "animaxia.namespace" -}}
{{- .Values.global.namespaceOverride | default .Release.Namespace -}}
{{- end -}}

{{/* common labels; pass (dict "root" $ "component" "api" "service" $svc) */}}
{{- define "animaxia.labels" -}}
{{- $root := .root -}}
{{- $name := .serviceName | default $root.Chart.Name -}}
helm.sh/chart: {{ include "animaxia.chart" $root }}
{{ include "animaxia.selectorLabels" (dict "root" $root "serviceName" $name) }}
{{- if $root.Chart.AppVersion }}
app.kubernetes.io/version: {{ $root.Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ $root.Release.Service }}
app.kubernetes.io/part-of: animaxia-cloud
{{- if .component }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}
{{- end -}}

{{/* selector labels; pass (dict "root" $ "serviceName" "auth-service") */}}
{{- define "animaxia.selectorLabels" -}}
app.kubernetes.io/name: {{ .serviceName | default "animaxia" }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/*
K8s resource name for a service from the services map.
Usage: include "animaxia.serviceName" (dict "root" $ "key" "auth" "service" $svc)
*/}}
{{- define "animaxia.serviceName" -}}
{{- $svc := .service | default dict -}}
{{- $svc.name | default (printf "%s-service" .key) -}}
{{- end -}}

{{/*
Full image reference for a service.
Usage: include "animaxia.image" (dict "root" $ "key" "auth" "service" $svc)
Precedence: services.<key>.repository (fully qualified) →
            <global.imageRegistry>/<image.repository>/<key>-service
Tag: services.<key>.tag → image.tag → "latest"
*/}}
{{- define "animaxia.image" -}}
{{- $root := .root -}}
{{- $svc := .service | default dict -}}
{{- $svcName := include "animaxia.serviceName" (dict "root" $root "key" .key "service" $svc) -}}
{{- $repo := $svc.repository | default (printf "%s/%s/%s" $root.Values.global.imageRegistry $root.Values.image.repository $svcName) -}}
{{- $tag := $svc.tag | default $root.Values.image.tag | default "latest" -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

{{/* ConfigMap name */}}
{{- define "animaxia.configMapName" -}}
{{- printf "%s-config" (include "animaxia.fullname" .) -}}
{{- end -}}

{{/* Secret name: existingSecret wins; else the chart-rendered one */}}
{{- define "animaxia.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secrets" (include "animaxia.fullname" .)) -}}
{{- end -}}

{{/* PVC name */}}
{{- define "animaxia.pvcName" -}}
{{- printf "%s-data" (include "animaxia.fullname" .) -}}
{{- end -}}

{{/* ServiceAccount name */}}
{{- define "animaxia.serviceAccountName" -}}
{{- if .Values.serviceAccount.name -}}
{{- .Values.serviceAccount.name -}}
{{- else if .Values.serviceAccount.create -}}
{{- include "animaxia.fullname" . -}}
{{- else -}}
{{- print "default" -}}
{{- end -}}
{{- end -}}

{{/* Pod annotation block for a service Deployment (checksums + prometheus) */}}
{{- define "animaxia.podAnnotations" -}}
{{- $root := .root -}}
{{- $svc := .service -}}
checksum/config: {{ include (print $root.Template.BasePath "/configmap.yaml") $root | sha256sum }}
checksum/secret: {{ include (print $root.Template.BasePath "/secret.yaml") $root | sha256sum }}
prometheus.io/scrape: {{ ternary "true" "false" ($root.Values.observability.metricsEnabled) | quote }}
prometheus.io/port: {{ $svc.port | quote }}
prometheus.io/path: "/metrics"
{{- range $key, $value := $root.Values.podAnnotations }}
{{ $key }}: {{ $value | toJson }}
{{- end -}}
{{- end -}}
