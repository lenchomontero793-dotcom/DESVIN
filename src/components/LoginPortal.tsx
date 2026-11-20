import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  Lock,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { AuthSession } from '../types';
import { apiFetch } from '../utils/apiClient';

interface LoginPortalProps {
  onLoginSuccess: (session: AuthSession) => void;
}

export function LoginPortal({ onLoginSuccess }: LoginPortalProps) {
  const [identifier, setIdentifier] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'No se pudo iniciar sesión.');
        return;
      }
      onLoginSuccess(data as AuthSession);
    } catch {
      setError('Error de conexión con el servidor de autenticación.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FAF9F5] text-[#141413] flex items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-5 bg-white border border-[#1F1E1D]/15 rounded-2xl overflow-hidden shadow-sm items-stretch">
        {/* Left Brand & Role Overview Column */}
        <div className="lg:col-span-2 bg-[#F5F4ED] border-b lg:border-b-0 lg:border-r border-[#1F1E1D]/10 p-6 md:p-8 flex flex-col justify-between gap-6">
          <div className="space-y-4">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-[#185FA5] text-white flex items-center justify-center shrink-0">
                <Users className="w-5 h-5" />
              </div>
              <div>
                <div className="text-base font-semibold text-[#141413] leading-tight">UserSync</div>
                <div className="text-[11px] text-[#5E5D57]">Gestión de Identidades v2.0</div>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <h1 className="text-xl font-semibold text-[#141413] leading-snug text-balance">
                Acceso unificado con control granular por rol
              </h1>
              <p className="text-xs text-[#5E5D57] leading-relaxed">
                Consolida usuarios entre SAP, Salesforce, Office 365 y plataformas propias, ejecuta cruces automáticos de 6 niveles, gestiona desvinculaciones y valida permisos en tiempo real.
              </p>
            </div>
          </div>

          <div className="space-y-2.5 pt-4 border-t border-[#1F1E1D]/10">
            <div className="flex items-center gap-2 text-xs font-medium text-[#3D3D3A]">
              <ShieldCheck className="w-4 h-4 text-[#185FA5] shrink-0" />
              <span>RBAC granular por módulo y acción</span>
            </div>
            <div className="text-[11px] text-[#73726C] leading-relaxed">
              Los operadores del sistema y colaboradores desactivados o desvinculados tienen el acceso bloqueado automáticamente.
            </div>
          </div>
        </div>

        {/* Right Login Form */}
        <div className="lg:col-span-3 p-6 md:p-8 flex flex-col justify-center space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-[#141413]">Iniciar sesión</h2>
            <p className="text-xs text-[#5E5D57] mt-0.5">
              Ingresa con tu usuario del sistema o correo corporativo autorizado.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label className="block text-xs font-medium text-[#3D3D3A]">
                Usuario o correo corporativo
              </label>
              <input
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin"
                className="w-full px-3.5 py-2.5 text-[13px] rounded-lg border border-[#1F1E1D]/20 bg-[#FAF9F5] focus:bg-white text-[#141413] outline-none focus:border-[#185FA5]"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-medium text-[#3D3D3A]">Contraseña</label>
              <div className="relative">
                <Lock className="w-4 h-4 text-[#73726C] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Ingresa tu contraseña"
                  className="w-full pl-9 pr-10 py-2.5 text-[13px] rounded-lg border border-[#1F1E1D]/20 bg-[#FAF9F5] focus:bg-white text-[#141413] outline-none focus:border-[#185FA5]"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-[#73726C] hover:text-[#141413]"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-[#FCEBEB] border border-[#A32D2D]/20 text-xs text-[#A32D2D]">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-medium rounded-lg bg-[#185FA5] hover:bg-[#144D87] text-white disabled:opacity-50 transition-colors"
            >
              <span>{loading ? 'Verificando acceso...' : 'Acceder al portal'}</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          </form>

          <div className="pt-3 border-t border-[#1F1E1D]/10 flex items-center justify-between text-[11px] text-[#73726C]">
            <span>Acceso administrador inicial</span>
            <span className="font-mono-tabular text-[#3D3D3A]">admin / admin123</span>
          </div>
        </div>
      </div>
    </div>
  );
}
