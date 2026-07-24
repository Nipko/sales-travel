'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import {
  Search,
  Plus,
  Users,
  FileText,
  UserCheck,
  Calendar,
  MoreVertical,
  Edit2,
  Trash2,
  X,
  CreditCard,
  Mail,
  Phone,
  Compass,
  AlertTriangle,
  Info,
  CheckCircle,
  Bot,
  Sparkles,
  MessageSquare,
  MapPin,
  Clock,
  ArrowRight,
  Kanban,
  Plane,
  ShieldCheck,
  Tag,
  DollarSign,
  ChevronRight,
} from 'lucide-react';

interface Customer {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  documentType: string;
  documentNumber: string;
  documentIssuingCountry: string;
  birthdate: string;
  gender: string;
  nationality: string;
  passportExpiry: string | null;
  preferences?: {
    meal?: string;
    seat?: string;
    hotelRoom?: string;
    specialNeeds?: string;
  };
  tags?: string[];
  createdAt: string;
}

interface Opportunity {
  id: string;
  tenantId: string;
  customerId: string;
  assignedUserId: string | null;
  stage:
    | 'AI_HANDLING'
    | 'LEAD_UNASSIGNED'
    | 'QUALIFIED_LEAD'
    | 'QUOTE_SENT'
    | 'NEGOTIATION'
    | 'BOOKING_CONFIRMED'
    | 'IN_TRAVEL'
    | 'POST_TRAVEL_COMPLETED'
    | 'CLOSED_LOST';
  title: string;
  estimatedValueMinor: number;
  currency: string;
  destinationCity: string | null;
  travelStartDate: string | null;
  travelEndDate: string | null;
  paxCount: number;
  packageQuotationId: string | null;
  orderId: string | null;
  sourceChannel: string;
  isAiControlled: boolean;
  lostReason: string | null;
  createdAt: string;
  customer?: {
    firstName?: string;
    lastName?: string;
    phone?: string;
    email?: string;
  };
}

interface ClientesClientProps {
  initialCustomers: Customer[];
  initialOpportunities?: Opportunity[];
}

const STAGES: { key: Opportunity['stage']; label: string; color: string; icon: any }[] = [
  { key: 'AI_HANDLING', label: 'Copiloto IA', color: 'border-purple-500/30 bg-purple-500/10 text-purple-400', icon: Bot },
  { key: 'QUALIFIED_LEAD', label: 'Calificado', color: 'border-blue-500/30 bg-blue-500/10 text-blue-400', icon: UserCheck },
  { key: 'QUOTE_SENT', label: 'Cotización Enviada', color: 'border-amber-500/30 bg-amber-500/10 text-amber-400', icon: FileText },
  { key: 'BOOKING_CONFIRMED', label: 'Reserva Confirmada', color: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400', icon: CheckCircle },
  { key: 'IN_TRAVEL', label: 'En Viaje', color: 'border-cyan-500/30 bg-cyan-500/10 text-cyan-400', icon: Plane },
  { key: 'POST_TRAVEL_COMPLETED', label: 'Completado', color: 'border-slate-500/30 bg-slate-500/10 text-slate-400', icon: Sparkles },
];

export function ClientesClient({
  initialCustomers,
  initialOpportunities = [],
}: ClientesClientProps) {
  const [activeView, setActiveView] = useState<'kanban' | 'directory'>('kanban');

  // Customer State
  const [customers, setCustomers] = useState<Customer[]>(initialCustomers);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGender, setSelectedGender] = useState('ALL');
  const [activeTab, setActiveTab] = useState<'all' | 'passports'>('all');

  // Opportunities State
  const [opportunities, setOpportunities] = useState<Opportunity[]>(initialOpportunities);
  const [isAddOppModalOpen, setIsAddOppModalOpen] = useState(false);
  const [oppTitle, setOppTitle] = useState('');
  const [oppCustomer, setOppCustomer] = useState(initialCustomers[0]?.id ?? '');
  const [oppValue, setOppValue] = useState('1500000');
  const [oppDestination, setOppDestination] = useState('Cancún (CUN)');
  const [oppPax, setOppPax] = useState('2');
  const [oppChannel, setOppChannel] = useState('WHATSAPP');

  // Modal states for customer
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states for customer
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState('PASAPORTE');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentIssuingCountry, setDocumentIssuingCountry] = useState('COL');
  const [birthdate, setBirthdate] = useState('1990-05-15');
  const [gender, setGender] = useState('M');
  const [nationality, setNationality] = useState('COL');
  const [passportExpiry, setPassportExpiry] = useState('2028-10-20');

  // Selected customer for detail drawer
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    initialCustomers[0] ?? null,
  );

  const filteredCustomers = customers.filter((c) => {
    const fullName = `${c.firstName} ${c.lastName}`.toLowerCase();
    const doc = c.documentNumber.toLowerCase();
    const mail = (c.email ?? '').toLowerCase();
    const matchesSearch =
      fullName.includes(searchTerm.toLowerCase()) ||
      doc.includes(searchTerm.toLowerCase()) ||
      mail.includes(searchTerm.toLowerCase());

    const matchesGender = selectedGender === 'ALL' || c.gender === selectedGender;

    if (activeTab === 'passports') {
      return matchesSearch && matchesGender && c.documentType === 'PASAPORTE';
    }

    return matchesSearch && matchesGender;
  });

  const handleOpenAddModal = () => {
    setIsEditMode(false);
    setEditingId(null);
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setDocumentType('PASAPORTE');
    setDocumentNumber('');
    setDocumentIssuingCountry('COL');
    setBirthdate('1990-05-15');
    setGender('M');
    setNationality('COL');
    setPassportExpiry('2028-10-20');
    setIsAddModalOpen(true);
  };

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !lastName || !documentNumber || !birthdate) {
      toast.error('Por favor complete todos los campos requeridos.');
      return;
    }

    const payload = {
      firstName,
      lastName,
      email: email || null,
      phone: phone || null,
      documentType,
      documentNumber,
      documentIssuingCountry,
      birthdate,
      gender,
      nationality,
      passportExpiry: passportExpiry || null,
    };

    if (isEditMode && editingId) {
      const res = await fetch(`/api/customers/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const { customer } = await res.json();
        const updatedList = customers.map((c) => (c.id === editingId ? customer : c));
        setCustomers(updatedList);
        if (selectedCustomer?.id === editingId) setSelectedCustomer(customer);
        setIsAddModalOpen(false);
      } else {
        toast.error('Error al actualizar el cliente');
      }
    } else {
      const res = await fetch('/api/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const { customer } = await res.json();
        setCustomers([customer, ...customers]);
        setSelectedCustomer(customer);
        setIsAddModalOpen(false);
      } else {
        toast.error('Error al crear el cliente');
      }
    }
  };

  const handleCreateOpportunity = (e: React.FormEvent) => {
    e.preventDefault();
    const custObj = customers.find((c) => c.id === oppCustomer);
    const newOpp: Opportunity = {
      id: `opp-${Date.now()}`,
      tenantId: 'tenant-1',
      customerId: oppCustomer,
      assignedUserId: null,
      stage: 'AI_HANDLING',
      title: oppTitle || `Viaje a ${oppDestination}`,
      estimatedValueMinor: Number(oppValue) || 1500000,
      currency: 'COP',
      destinationCity: oppDestination,
      travelStartDate: '2026-10-10',
      travelEndDate: '2026-10-17',
      paxCount: Number(oppPax) || 2,
      packageQuotationId: null,
      orderId: null,
      sourceChannel: oppChannel,
      isAiControlled: true,
      lostReason: null,
      createdAt: new Date().toISOString(),
      customer: {
        firstName: custObj?.firstName ?? 'Cliente',
        lastName: custObj?.lastName ?? 'Viajero',
        phone: custObj?.phone ?? '+573000000000',
        email: custObj?.email ?? '',
      },
    };

    setOpportunities([newOpp, ...opportunities]);
    setIsAddOppModalOpen(false);
    setOppTitle('');
  };

  const handleDelete = async (id: string) => {
    if (!confirm('¿Está seguro de eliminar este pasajero de la base de datos?')) return;
    const res = await fetch(`/api/customers/${id}`, { method: 'DELETE' });
    if (res.ok) {
      const updatedList = customers.filter((c) => c.id !== id);
      setCustomers(updatedList);
      if (selectedCustomer?.id === id) {
        setSelectedCustomer(updatedList[0] ?? null);
      }
    } else {
      toast.error('Error al eliminar cliente');
    }
=======
    setOpportunities([newOpp, ...opportunities]);
    setIsAddOppModalOpen(false);
    setOppTitle('');
  };

  const handleMoveStage = (oppId: string, nextStage: Opportunity['stage']) => {
    setOpportunities((prev) =>
      prev.map((o) => (o.id === oppId ? { ...o, stage: nextStage } : o)),
    );
>>>>>>> Stashed changes
  };

  const isPassportExpiringSoon = (expiryDate: string | null) => {
    if (!expiryDate) return false;
    const exp = new Date(expiryDate);
    const sixMonthsFromNow = new Date();
    sixMonthsFromNow.setMonth(sixMonthsFromNow.getMonth() + 6);
    return exp <= sixMonthsFromNow;
  };

  return (
    <div className="p-6 max-w-[1600px] mx-auto space-y-6">
      {/* HEADER PRINCIPAL & SWICHER DE VISTAS */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-bold tracking-tight text-white">Travel CRM Conversacional</h1>
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <Bot className="size-3.5" /> IA Native M9
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Gestión inteligente de oportunidades de viajes, atención automática por WhatsApp y expediente 360° de pasajeros.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* View Switcher */}
          <div className="flex bg-slate-900 border border-slate-800 rounded-lg p-1">
            <button
              onClick={() => setActiveView('kanban')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                activeView === 'kanban'
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Kanban className="size-3.5" /> Pipeline Kanban
            </button>
            <button
              onClick={() => setActiveView('directory')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-semibold transition-all ${
                activeView === 'directory'
                  ? 'bg-[var(--color-primary)] text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Users className="size-3.5" /> Directorio Viajeros
            </button>
          </div>

          {activeView === 'kanban' ? (
            <button
              onClick={() => setIsAddOppModalOpen(true)}
              className="inline-flex items-center gap-2 bg-[var(--color-primary)] hover:bg-sky-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all shadow-md"
            >
              <Plus className="size-4" /> Nueva Oportunidad
            </button>
          ) : (
            <button
              onClick={handleOpenAddModal}
              className="inline-flex items-center gap-2 bg-[var(--color-primary)] hover:bg-sky-500 text-white text-xs font-semibold px-4 py-2 rounded-lg transition-all shadow-md"
            >
              <Plus className="size-4" /> Nuevo Viajero
            </button>
          )}
        </div>
      </div>

      {/* METRICAS RAPIDAS CRM */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Atendidos por IA (WhatsApp)</p>
            <p className="text-2xl font-bold text-purple-400 mt-1">
              {opportunities.filter((o) => o.isAiControlled || o.stage === 'AI_HANDLING').length}
            </p>
          </div>
          <div className="size-10 rounded-lg bg-purple-500/10 border border-purple-500/20 flex items-center justify-center">
            <Bot className="size-5 text-purple-400" />
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Cotizaciones Activas</p>
            <p className="text-2xl font-bold text-amber-400 mt-1">
              {opportunities.filter((o) => o.stage === 'QUOTE_SENT' || o.stage === 'QUALIFIED_LEAD').length}
            </p>
          </div>
          <div className="size-10 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
            <FileText className="size-5 text-amber-400" />
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Pasajeros Registrados</p>
            <p className="text-2xl font-bold text-emerald-400 mt-1">{customers.length}</p>
          </div>
          <div className="size-10 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
            <Users className="size-5 text-emerald-400" />
          </div>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 flex items-center justify-between">
          <div>
            <p className="text-xs text-slate-400 font-medium">Pasaportes por Vencer</p>
            <p className="text-2xl font-bold text-rose-400 mt-1">
              {customers.filter((c) => isPassportExpiringSoon(c.passportExpiry)).length}
            </p>
          </div>
          <div className="size-10 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center">
            <AlertTriangle className="size-5 text-rose-400" />
          </div>
        </div>
      </div>

      {/* VISTA 1: PIPELINE KANBAN DE OPORTUNIDADES */}
      {activeView === 'kanban' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4 overflow-x-auto pb-4">
            {STAGES.map((stg) => {
              const StageIcon = stg.icon;
              const stageOpps = opportunities.filter((o) => o.stage === stg.key);
              return (
                <div
                  key={stg.key}
                  className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3.5 flex flex-col min-h-[500px] space-y-3"
                >
                  <div className="flex items-center justify-between border-b border-slate-800/60 pb-2.5">
                    <div className="flex items-center gap-2">
                      <StageIcon className="size-4 text-slate-400" />
                      <h3 className="text-xs font-bold text-slate-200">{stg.label}</h3>
                    </div>
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-800 text-slate-300">
                      {stageOpps.length}
                    </span>
                  </div>

                  <div className="flex-1 space-y-3">
                    {stageOpps.length === 0 ? (
                      <div className="h-32 border border-dashed border-slate-800/60 rounded-lg flex items-center justify-center text-[11px] text-slate-600 font-medium">
                        Sin oportunidades
                      </div>
                    ) : (
                      stageOpps.map((opp) => (
                        <div
                          key={opp.id}
                          className="group relative rounded-lg border border-slate-800 bg-slate-900/80 hover:bg-slate-900 p-3.5 transition-all shadow-sm space-y-2.5 hover:border-slate-700"
                        >
                          {opp.isAiControlled && (
                            <div className="flex items-center justify-between">
                              <span className="inline-flex items-center gap-1 text-[9px] font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                                <Bot className="size-3" /> Copiloto IA Atendiendo
                              </span>
                              <span className="text-[10px] text-slate-500 font-mono">
                                WhatsApp
                              </span>
                            </div>
                          )}

                          <div>
                            <h4 className="text-xs font-semibold text-white group-hover:text-sky-400 transition-colors">
                              {opp.title}
                            </h4>
                            <p className="text-[11px] text-slate-400 mt-0.5">
                              {opp.customer?.firstName} {opp.customer?.lastName}
                            </p>
                          </div>

                          <div className="flex items-center justify-between text-[11px] text-slate-300 pt-1 border-t border-slate-800/60 font-mono">
                            <span className="flex items-center gap-1 text-slate-400">
                              <MapPin className="size-3 text-sky-400" /> {opp.destinationCity ?? 'N/A'}
                            </span>
                            <span className="font-bold text-emerald-400">
                              ${(opp.estimatedValueMinor / 100).toLocaleString('es-CO')} {opp.currency}
                            </span>
                          </div>

                          {/* Stage Transition Selector */}
                          <div className="pt-2 flex items-center justify-between">
                            <a
                              href={`https://wa.me/${(opp.customer?.phone ?? '').replace(/[^0-9]/g, '')}`}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[10px] text-emerald-400 hover:text-emerald-300 font-medium"
                            >
                              <MessageSquare className="size-3" /> Chat WhatsApp
                            </a>

                            <select
                              value={opp.stage}
                              onChange={(e) => handleMoveStage(opp.id, e.target.value as Opportunity['stage'])}
                              className="bg-slate-950 text-[10px] text-slate-300 border border-slate-800 rounded px-1.5 py-0.5 focus:outline-none focus:border-sky-500"
                            >
                              {STAGES.map((s) => (
                                <option key={s.key} value={s.key}>
                                  ➔ {s.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* VISTA 2: DIRECTORIO DE VIAJEROS (FICHA 360°) */}
      {activeView === 'directory' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* TABLA Y FILTROS VIAJEROS */}
          <div className="lg:col-span-8 space-y-4">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-slate-900/60 border border-slate-800 rounded-xl p-3.5">
              <div className="relative flex-1 w-full">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-slate-500" />
                <input
                  type="text"
                  placeholder="Buscar por nombre, pasaporte o documento..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full bg-slate-950 text-xs text-white placeholder-slate-500 pl-9 pr-3 py-2 rounded-lg border border-slate-800 focus:outline-none focus:border-sky-500"
                />
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={() => setActiveTab('all')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    activeTab === 'all'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Todos ({customers.length})
                </button>
                <button
                  onClick={() => setActiveTab('passports')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                    activeTab === 'passports'
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  Solo Pasaportes
                </button>
              </div>
            </div>

            {/* TABLA CUSTOMERS */}
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <table className="w-full text-left text-xs text-slate-300">
                <thead className="bg-slate-950 text-slate-400 border-b border-slate-800 uppercase font-semibold text-[10px] tracking-wider">
                  <tr>
                    <th className="py-3 px-4">Viajero</th>
                    <th className="py-3 px-4">Documento / Pasaporte</th>
                    <th className="py-3 px-4">Contacto</th>
                    <th className="py-3 px-4">Estado Pasaporte</th>
                    <th className="py-3 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {filteredCustomers.map((cust) => {
                    const isExpiring = isPassportExpiringSoon(cust.passportExpiry);
                    const isSelected = selectedCustomer?.id === cust.id;
                    return (
                      <tr
                        key={cust.id}
                        onClick={() => setSelectedCustomer(cust)}
                        className={`cursor-pointer transition-colors ${
                          isSelected ? 'bg-sky-500/10' : 'hover:bg-slate-800/40'
                        }`}
                      >
                        <td className="py-3 px-4">
                          <div className="font-semibold text-white">
                            {cust.firstName} {cust.lastName}
                          </div>
                          <div className="text-[10px] text-slate-400">Nac: {cust.birthdate}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-mono text-slate-200">
                            {cust.documentType}: {cust.documentNumber}
                          </div>
                          <div className="text-[10px] text-slate-400">{cust.documentIssuingCountry}</div>
                        </td>
                        <td className="py-3 px-4">
                          <div className="text-slate-300">{cust.phone ?? 'Sin teléfono'}</div>
                          <div className="text-[10px] text-slate-500">{cust.email ?? 'Sin email'}</div>
                        </td>
                        <td className="py-3 px-4">
                          {cust.passportExpiry ? (
                            isExpiring ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-500/10 text-rose-400 border border-rose-500/20">
                                <AlertTriangle className="size-3" /> Vence: {cust.passportExpiry}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                <ShieldCheck className="size-3" /> Vigente ({cust.passportExpiry})
                              </span>
                            )
                          ) : (
                            <span className="text-[10px] text-slate-500">Sin pasaporte</span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <a
                            href={`https://wa.me/${(cust.phone ?? '').replace(/[^0-9]/g, '')}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 font-medium px-2 py-1 rounded hover:bg-emerald-500/10"
                          >
                            <MessageSquare className="size-3.5" /> WhatsApp
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* FICHA DETALLE 360 DEL CLIENTE SELECCIONADO */}
          <div className="lg:col-span-4">
            {selectedCustomer ? (
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-5 sticky top-6">
                <div className="flex items-center justify-between border-b border-slate-800 pb-4">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      {selectedCustomer.firstName} {selectedCustomer.lastName}
                    </h3>
                    <p className="text-xs text-slate-400">Expediente del Viajero 360°</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-sky-500/10 text-sky-400 border border-sky-500/20">
                    {selectedCustomer.nationality}
                  </span>
                </div>

                {/* DATOS PERSONALES */}
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex justify-between py-1 border-b border-slate-800/40">
                    <span className="text-slate-400">Documento:</span>
                    <span className="font-mono text-white">
                      {selectedCustomer.documentType} {selectedCustomer.documentNumber}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/40">
                    <span className="text-slate-400">WhatsApp:</span>
                    <span className="text-emerald-400 font-mono">{selectedCustomer.phone}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/40">
                    <span className="text-slate-400">Email:</span>
                    <span className="text-slate-200">{selectedCustomer.email}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/40">
                    <span className="text-slate-400">Fecha Nacimiento:</span>
                    <span>{selectedCustomer.birthdate}</span>
                  </div>
                </div>

                {/* ETIQUETAS & PREFERENCIAS */}
                <div className="space-y-2">
                  <h4 className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                    Preferencias de Viaje
                  </h4>
                  <div className="p-3 rounded-lg bg-slate-950 border border-slate-800/60 text-xs text-slate-400 space-y-1">
                    <p>💺 Asiento: Pasillo preferido</p>
                    <p>🥗 Dieta: Sin restricciones</p>
                    <p>🏨 Hotel: Cama King, piso alto</p>
                  </div>
                </div>

                {/* ACCIONES RAPIDAS */}
                <div className="pt-2">
                  <a
                    href={`https://wa.me/${(selectedCustomer.phone ?? '').replace(/[^0-9]/g, '')}`}
                    target="_blank"
                    rel="noreferrer"
                    className="w-full inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs py-2.5 rounded-lg transition-all shadow-md"
                  >
                    <MessageSquare className="size-4" /> Iniciar Chat por WhatsApp
                  </a>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-xs text-slate-500">
                Selecciona un viajero para ver su expediente 360°
              </div>
            )}
          </div>
        </div>
      )}

      {/* MODAL: NUEVA OPORTUNIDAD */}
      {isAddOppModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Kanban className="size-4 text-sky-400" /> Crear Oportunidad de Viaje
              </h3>
              <button onClick={() => setIsAddOppModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="size-5" />
              </button>
            </div>

            <form onSubmit={handleCreateOpportunity} className="space-y-3.5 text-xs">
              <div>
                <label className="block text-slate-400 font-medium mb-1">Título de la Oportunidad</label>
                <input
                  type="text"
                  required
                  placeholder="Ej: Vacaciones Cancún 7 Noches"
                  value={oppTitle}
                  onChange={(e) => setOppTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                />
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Viajero / Cliente</label>
                <select
                  value={oppCustomer}
                  onChange={(e) => setOppCustomer(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.firstName} {c.lastName} ({c.phone})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Destino</label>
                  <input
                    type="text"
                    placeholder="Cancún (CUN)"
                    value={oppDestination}
                    onChange={(e) => setOppDestination(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Pasajeros</label>
                  <input
                    type="number"
                    min="1"
                    value={oppPax}
                    onChange={(e) => setOppPax(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 font-medium mb-1">Valor Estimado (COP)</label>
                <input
                  type="number"
                  placeholder="1500000"
                  value={oppValue}
                  onChange={(e) => setOppValue(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500 font-mono"
                />
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddOppModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 font-semibold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-semibold shadow-md"
                >
                  Crear Oportunidad
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: NUEVO VIAJERO */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-lg p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Users className="size-4 text-sky-400" /> Registrar Nuevo Viajero
              </h3>
              <button onClick={() => setIsAddModalOpen(false)} className="text-slate-400 hover:text-white">
                <X className="size-5" />
              </button>
            </div>

            <form onSubmit={handleCreateCustomer} className="space-y-3.5 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Nombres</label>
                  <input
                    type="text"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Apellidos</label>
                  <input
                    type="text"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Teléfono / WhatsApp</label>
                  <input
                    type="text"
                    placeholder="+573001234567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Email</label>
                  <input
                    type="email"
                    placeholder="cliente@email.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Tipo Doc</label>
                  <select
                    value={documentType}
                    onChange={(e) => setDocumentType(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  >
                    <option value="PASAPORTE">PASAPORTE</option>
                    <option value="CC">CC</option>
                    <option value="CE">CE</option>
                    <option value="DNI">DNI</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Número</label>
                  <input
                    type="text"
                    required
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 font-medium mb-1">Venc. Pasaporte</label>
                  <input
                    type="date"
                    value={passportExpiry}
                    onChange={(e) => setPassportExpiry(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg p-2.5 text-white focus:outline-none focus:border-sky-500"
                  />
                </div>
              </div>

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2 rounded-lg bg-slate-800 text-slate-300 font-semibold"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white font-semibold shadow-md"
                >
                  Guardar Viajero
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
