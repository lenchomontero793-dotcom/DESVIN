import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  History,
  Send,
  ShieldAlert,
  Sparkles,
  Undo2,
  XCircle,
} from 'lucide-react';
import type { AiProposalCard, AppStateResponse } from '../types';
import { apiFetch } from '../utils/apiClient';
import { formatRelativeTime } from '../utils/formatters';

interface AssistantViewProps {
  token: string;
  aiConfigured: boolean;
  onStateReplace: (nextState: AppStateResponse) => void;
  onNotify: (msg: string, tone?: 'success' | 'error') => void;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  proposals?: AiProposalCard[];
}

const QUICK_PROMPTS = [
  'Revisa la configuración actual y detecta mejoras recomendadas',
  'Activa sincronización automática de SAP cada 12 horas',
  'Crea un rol Auditoría de solo lectura para usuarios, reportes y audit log',
  'Crea un respaldo preventivo con nota de auditoría',
];

export function AssistantView({
  token,
  aiConfigured,
  onStateReplace,
  onNotify,
}: AssistantViewProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<AiProposalCard[]>([]);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await apiFetch('/api/assistant/history', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { recent?: AiProposalCard[] };
      setHistory(Array.isArray(data.recent) ? data.recent : []);
    } catch {
      // ignore transient fetch errors
    }
  }, [token]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const sendMessage = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    const userTurn: ChatTurn = { id: `u-${Date.now()}`, role: 'user', content: trimmed };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setInput('');
    setSending(true);

    try {
      const res = await apiFetch('/api/assistant/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          messages: nextTurns.map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || 'No se pudo consultar al asistente IA.', 'error');
        return;
      }

      const botTurn: ChatTurn = {
        id: `a-${Date.now()}`,
        role: 'assistant',
        content: data.reply || '',
        proposals: Array.isArray(data.proposals) ? data.proposals : [],
      };
      setTurns((prev) => [...prev, botTurn]);
      void loadHistory();
    } catch {
      onNotify('Error de comunicación con el asistente IA.', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void sendMessage(input);
  };

  const updateProposalStatusInTurns = (
    proposalId: string,
    status: AiProposalCard['status'],
    undoable?: boolean,
  ) => {
    setTurns((prev) =>
      prev.map((t) => ({
        ...t,
        proposals: t.proposals?.map((p) =>
          p.id === proposalId ? { ...p, status, undoable: undoable ?? p.undoable } : p,
        ),
      })),
    );
  };

  const handleApplyProposal = async (proposalId: string) => {
    setBusyProposalId(proposalId);
    try {
      const res = await apiFetch(`/api/assistant/proposals/${encodeURIComponent(proposalId)}/apply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || 'No se pudo aplicar la propuesta.', 'error');
        return;
      }
      updateProposalStatusInTurns(proposalId, 'aplicada', data.undoable);
      if (data.state) onStateReplace(data.state as AppStateResponse);
      onNotify(data.message || 'Cambio aplicado correctamente.');
      void loadHistory();
    } catch {
      onNotify('Error de red al aplicar la propuesta.', 'error');
    } finally {
      setBusyProposalId(null);
    }
  };

  const handleDiscardProposal = async (proposalId: string) => {
    setBusyProposalId(proposalId);
    try {
      const res = await apiFetch(
        `/api/assistant/proposals/${encodeURIComponent(proposalId)}/discard`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        const data = await res.json();
        onNotify(data.error || 'No se pudo descartar.', 'error');
        return;
      }
      updateProposalStatusInTurns(proposalId, 'descartada');
      onNotify('Propuesta descartada.');
      void loadHistory();
    } finally {
      setBusyProposalId(null);
    }
  };

  const handleUndoProposal = async (proposalId: string) => {
    setBusyProposalId(proposalId);
    try {
      const res = await apiFetch(`/api/assistant/proposals/${encodeURIComponent(proposalId)}/undo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok) {
        onNotify(data.error || 'No se pudo deshacer el cambio.', 'error');
        return;
      }
      updateProposalStatusInTurns(proposalId, 'deshecha', false);
      if (data.state) onStateReplace(data.state as AppStateResponse);
      onNotify(data.message || 'Cambio revertido.');
      void loadHistory();
    } finally {
      setBusyProposalId(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[16px] font-semibold text-[#141413] flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-[#185FA5]" />
            <span>Asistente de configuración UserSync</span>
          </h2>
          <p className="text-xs text-[#5E5D57] mt-0.5">
            Analiza la configuración del servicio, sugiere ajustes con vista previa "Ahora → Propuesto" y permite revertir cambios aplicados con un clic.
          </p>
        </div>

        <span
          className={`text-xs font-medium px-2.5 py-1 rounded-md border ${
            aiConfigured
              ? 'bg-[#EAF3DE] border-[#639922]/30 text-[#2E6B1E]'
              : 'bg-[#FAEEDA] border-[#BA7517]/30 text-[#633806]'
          }`}
        >
          {aiConfigured ? 'Motor Gemini conectado' : 'GEMINI_API_KEY no definida en secretos'}
        </span>
      </div>

      {!aiConfigured && (
        <div className="p-4 rounded-xl bg-[#FAEEDA] border border-[#BA7517]/30 flex items-start gap-3 text-xs text-[#633806]">
          <AlertTriangle className="w-4 h-4 text-[#BA7517] shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">Asistente en espera de configuración de entorno</div>
            <div className="mt-0.5">
              Para habilitar respuestas generativas, configura la variable de entorno <code className="font-mono-tabular">GEMINI_API_KEY</code> en el panel de Secretos del proyecto. Ningún dato personal (RUT, correos ni contraseñas) se envía al modelo.
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
        {/* Main Chat Area */}
        <div className="lg:col-span-2 bg-white border border-[#1F1E1D]/15 rounded-xl flex flex-col overflow-hidden">
          <div className="p-4 border-b border-[#1F1E1D]/10 bg-[#FAF9F5] space-y-2">
            <div className="text-[11px] font-semibold text-[#5E5D57]">
              Consultas rápidas de configuración
            </div>
            <div className="flex flex-wrap gap-1.5">
              {QUICK_PROMPTS.map((qp) => (
                <button
                  key={qp}
                  type="button"
                  disabled={sending || !aiConfigured}
                  onClick={() => void sendMessage(qp)}
                  className="px-2.5 py-1 text-[11px] rounded-md border border-[#1F1E1D]/15 bg-white hover:bg-[#E6F1FB] hover:border-[#185FA5]/40 text-[#3D3D3A] disabled:opacity-50 text-left"
                >
                  {qp}
                </button>
              ))}
            </div>
          </div>

          <div className="p-4 space-y-4 min-h-[340px] max-h-[540px] overflow-y-auto">
            {turns.length === 0 ? (
              <div className="py-12 text-center space-y-2 text-[#5E5D57]">
                <Sparkles className="w-7 h-7 text-[#185FA5] mx-auto" />
                <div className="text-sm font-medium text-[#141413]">
                  ¿Qué ajuste quieres revisar o automatizar?
                </div>
                <p className="text-xs max-w-md mx-auto">
                  Puedes pedir cambios en parámetros del servicio, programación API de plataformas, creación o edición de roles RBAC, o snapshots de respaldo. Cada cambio requiere tu confirmación explícita.
                </p>
              </div>
            ) : (
              turns.map((turn) => (
                <div
                  key={turn.id}
                  className={`flex flex-col gap-2 ${
                    turn.role === 'user' ? 'items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`max-w-[88%] rounded-xl px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                      turn.role === 'user'
                        ? 'bg-[#185FA5] text-white'
                        : 'bg-[#FAF9F5] border border-[#1F1E1D]/15 text-[#141413]'
                    }`}
                  >
                    {turn.content}
                  </div>

                  {turn.proposals && turn.proposals.length > 0 && (
                    <div className="w-full space-y-3 mt-1">
                      {turn.proposals.map((prop, pIdx) => {
                        const isBusy = prop.id !== null && busyProposalId === prop.id;
                        const status = prop.status || 'pendiente';
                        return (
                          <div
                            key={prop.id || pIdx}
                            className="border border-[#185FA5]/30 bg-white rounded-xl p-4 space-y-3"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="text-xs font-semibold text-[#141413] flex items-center gap-1.5">
                                  {prop.sensitive && (
                                    <ShieldAlert className="w-3.5 h-3.5 text-[#BA7517] shrink-0" />
                                  )}
                                  <span>{prop.title}</span>
                                </div>
                                {prop.reason && (
                                  <p className="text-[11px] text-[#5E5D57] mt-0.5">{prop.reason}</p>
                                )}
                              </div>

                              <span className="text-[10px] font-mono-tabular uppercase px-2 py-0.5 rounded bg-[#F5F4ED] text-[#5E5D57]">
                                {status}
                              </span>
                            </div>

                            {prop.changes.length > 0 && (
                              <div className="border border-[#1F1E1D]/10 rounded-lg overflow-hidden">
                                <table className="w-full text-left text-[11px] border-collapse">
                                  <thead>
                                    <tr className="bg-[#F5F4ED] text-[#5E5D57]">
                                      <th className="py-1.5 px-2.5">Campo</th>
                                      <th className="py-1.5 px-2.5">Ahora</th>
                                      <th className="py-1.5 px-2.5">Propuesto</th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-[#1F1E1D]/10">
                                    {prop.changes.map((ch, cIdx) => (
                                      <tr key={cIdx}>
                                        <td className="py-1.5 px-2.5 font-medium text-[#141413]">
                                          {ch.label}
                                        </td>
                                        <td className="py-1.5 px-2.5 font-mono-tabular text-[#73726C]">
                                          {ch.current}
                                        </td>
                                        <td className="py-1.5 px-2.5 font-mono-tabular font-semibold text-[#185FA5]">
                                          <span className="inline-flex items-center gap-1">
                                            <ArrowRight className="w-3 h-3 shrink-0" />
                                            <span>{ch.new}</span>
                                          </span>
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}

                            {prop.warnings.map((w, wi) => (
                              <div
                                key={wi}
                                className="text-[11px] text-[#633806] bg-[#FAEEDA] px-2.5 py-1.5 rounded flex items-center gap-1.5"
                              >
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                                <span>{w}</span>
                              </div>
                            ))}
                            {prop.errors.map((err, ei) => (
                              <div
                                key={ei}
                                className="text-[11px] text-[#A32D2D] bg-[#FCEBEB] px-2.5 py-1.5 rounded flex items-center gap-1.5"
                              >
                                <XCircle className="w-3.5 h-3.5 shrink-0" />
                                <span>{err}</span>
                              </div>
                            ))}

                            {prop.id && status === 'pendiente' && (
                              <div className="flex items-center justify-end gap-2 pt-1">
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleDiscardProposal(prop.id!)}
                                  className="px-3 py-1.5 text-xs font-medium rounded-lg border border-[#1F1E1D]/20 hover:bg-[#F3F2EC] text-[#3D3D3A]"
                                >
                                  Descartar
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy || !prop.canApply}
                                  onClick={() => handleApplyProposal(prop.id!)}
                                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  <span>{isBusy ? 'Aplicando...' : 'Aplicar cambio'}</span>
                                </button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}
            {sending && (
              <div className="text-xs text-[#5E5D57] italic">Analizando configuración...</div>
            )}
          </div>

          <form
            onSubmit={handleSubmit}
            className="p-3 border-t border-[#1F1E1D]/10 bg-[#FAF9F5] flex items-center gap-2"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={!aiConfigured || sending}
              placeholder={
                aiConfigured
                  ? 'Describe el cambio o consulta de configuración...'
                  : 'Configura GEMINI_API_KEY en el entorno para consultar'
              }
              className="flex-1 px-3 py-2 text-xs rounded-lg border border-[#1F1E1D]/20 bg-white outline-none focus:border-[#185FA5] disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!aiConfigured || sending || !input.trim()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-[#185FA5] text-white hover:bg-[#144D87] disabled:opacity-50 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Enviar</span>
            </button>
          </form>
        </div>

        {/* Recent Applied AI History with 1-Click Undo */}
        <div className="bg-white border border-[#1F1E1D]/15 rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-[#141413] flex items-center gap-2">
            <History className="w-4 h-4 text-[#185FA5]" />
            <span>Cambios recientes con IA</span>
          </h3>
          <p className="text-[11px] text-[#5E5D57]">
            Cada cambio aplicado guarda un snapshot previo para revertirlo con un clic.
          </p>

          {history.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#73726C]">
              Aún no se han aplicado propuestas del asistente en esta instancia.
            </div>
          ) : (
            <div className="space-y-2.5 max-h-[460px] overflow-y-auto">
              {history.map((item) => (
                <div
                  key={item.id || item.title}
                  className="p-3 rounded-lg bg-[#FAF9F5] border border-[#1F1E1D]/10 space-y-2 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-[#141413]">{item.title}</div>
                    <span className="text-[10px] uppercase font-mono-tabular text-[#5E5D57] shrink-0">
                      {item.status}
                    </span>
                  </div>
                  {item.appliedAt && (
                    <div className="text-[10px] text-[#73726C] tabular-nums">
                      {formatRelativeTime(item.appliedAt)}
                    </div>
                  )}
                  {item.id && item.status === 'aplicada' && item.undoable && (
                    <button
                      type="button"
                      disabled={busyProposalId === item.id}
                      onClick={() => handleUndoProposal(item.id!)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded border border-[#1F1E1D]/20 bg-white hover:bg-[#F3F2EC] text-[#141413]"
                    >
                      <Undo2 className="w-3 h-3" />
                      <span>Deshacer cambio</span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
