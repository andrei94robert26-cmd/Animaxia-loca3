/**
 * common/config.js — Central configuration helpers for every Animaxia Cloud
 * microservice. Env names follow the Animaxia house style (see BLUEPRINT §9):
 * mostly no underscores, with the documented legacy exceptions kept verbatim.
 */

export function envStr(name, def = '') {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return def;
  return String(value);
}

export function envInt(name, def = 0) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : def;
}

export function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

export const cfg = {
  get env() {
    return process.env.NODE_ENV || 'development';
  },
  get isProd() {
    return (process.env.NODE_ENV || 'development') === 'production';
  },
  get isDev() {
    return (process.env.NODE_ENV || 'development') === 'development';
  },
  get serviceName() {
    return process.env.SERVICENAME || 'animaxia-service';
  },
  get servicePort() {
    // Precedence: PORT (docker/k8s convention) → per-service override → 8080.
    const port = parseInt(process.env.PORT || process.env.SERVICEPORT || '', 10);
    return Number.isFinite(port) && port > 0 ? port : 8080;
  },
  get tracingEnabled() {
    return envBool('TRACINGENABLED', true);
  },
  get metricsEnabled() {
    return envBool('METRICSENABLED', true);
  },
};
