{{/*
Browser HITL Helm Chart - Template Helpers
*/}}

{{/*
Expand the name of the chart.
*/}}
{{- define "browser-hitl.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
*/}}
{{- define "browser-hitl.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "browser-hitl.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "browser-hitl.labels" -}}
helm.sh/chart: {{ include "browser-hitl.chart" . }}
{{ include "browser-hitl.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "browser-hitl.selectorLabels" -}}
app.kubernetes.io/name: {{ include "browser-hitl.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Component-specific labels
*/}}
{{- define "browser-hitl.componentLabels" -}}
{{ include "browser-hitl.labels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Component-specific selector labels
*/}}
{{- define "browser-hitl.componentSelectorLabels" -}}
{{ include "browser-hitl.selectorLabels" . }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{/*
Image pull secrets
*/}}
{{- define "browser-hitl.imagePullSecrets" -}}
{{- if .Values.global.imagePullSecrets }}
imagePullSecrets:
{{- range .Values.global.imagePullSecrets }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Resolve image reference with optional global registry prefix
*/}}
{{- define "browser-hitl.image" -}}
{{- $registry := .global.imageRegistry -}}
{{- if $registry -}}
{{- printf "%s/%s:%s" $registry .image.repository .image.tag -}}
{{- else -}}
{{- printf "%s:%s" .image.repository .image.tag -}}
{{- end -}}
{{- end }}

{{/*
Resolve storage class. Use component-specific, then global, then cluster default.
*/}}
{{- define "browser-hitl.storageClass" -}}
{{- if .storageClass -}}
storageClassName: {{ .storageClass | quote }}
{{- else if .global.storageClass -}}
storageClassName: {{ .global.storageClass | quote }}
{{- end -}}
{{- end }}

{{/*
Secret name
*/}}
{{- define "browser-hitl.secretName" -}}
{{ include "browser-hitl.fullname" . }}-secrets
{{- end }}

{{/*
Configmap name
*/}}
{{- define "browser-hitl.configmapName" -}}
{{ include "browser-hitl.fullname" . }}-config
{{- end }}
