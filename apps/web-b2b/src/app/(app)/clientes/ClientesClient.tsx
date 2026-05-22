'use client';

import { useState } from 'react';
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
  preferences: {
    meal?: string;
    seat?: string;
    hotelRoom?: string;
    specialNeeds?: string;
  };
  createdAt: string;
}

interface ClientesClientProps {
  initialCustomers: Customer[];
}

export function ClientesClient({ initialCustomers }: ClientesClientProps) {
  const [customers, setCustomers] = useState<Customer[]>(initialCustomers);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedGender, setSelectedGender] = useState('ALL');
  const [activeTab, setActiveTab] = useState<'all' | 'passports'>('all');

  // Modal states
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form states
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [documentType, setDocumentType] = useState('PASAPORTE');
  const [documentNumber, setDocumentNumber] = useState('');
  const [documentIssuingCountry, setDocumentIssuingCountry] = useState('COL');
  const [birthdate, setBirthdate] = useState('');
  const [gender, setGender] = useState('M');
  const [nationality, setNationality] = useState('COL');
  const [passportExpiry, setPassportExpiry] = useState('');
  const [mealPref, setMealPref] = useState('');
  const [seatPref, setSeatPref] = useState('');

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
    setBirthdate('');
    setGender('M');
    setNationality('COL');
    setPassportExpiry('');
    setMealPref('');
    setSeatPref('');
    setIsAddModalOpen(true);
  };

  const handleOpenEditModal = (c: Customer) => {
    setIsEditMode(true);
    setEditingId(c.id);
    setFirstName(c.firstName);
    setLastName(c.lastName);
    setEmail(c.email ?? '');
    setPhone(c.phone ?? '');
    setDocumentType(c.documentType);
    setDocumentNumber(c.documentNumber);
    setDocumentIssuingCountry(c.documentIssuingCountry);
    setBirthdate(c.birthdate ? c.birthdate.split('T')[0] : '');
    setGender(c.gender);
    setNationality(c.nationality);
    setPassportExpiry(c.passportExpiry ? c.passportExpiry.split('T')[0] : '');
    setMealPref(c.preferences?.meal ?? '');
    setSeatPref(c.preferences?.seat ?? '');
    setIsAddModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !lastName || !documentNumber || !birthdate) {
      alert('Por favor complete todos los campos requeridos.');
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
      preferences: {
        meal: mealPref || undefined,
        seat: seatPref || undefined,
      },
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
        alert('Error al actualizar el cliente');
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
        alert('Error al crear el cliente');
      }
    }
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
      alert('Error al eliminar cliente');
    }
  };

  const getExpiryDays = (dateStr: string | null) => {
    if (!dateStr) return null;
    const expiry = new Date(dateStr);
    const today = new Date();
    const diffTime = expiry.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return diffDays;
  };

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 lg:px-8 space-y-8 animate-fade-in">
      {/* Header */}
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-primary)]/10 px-2.5 py-0.5 text-[10px] font-bold text-[var(--color-primary)] uppercase tracking-wider">
            <Users className="size-3" />
            CRM de Pasajeros
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--color-fg)] mt-1.5">
            Clientes & Pasajeros
          </h1>
          <p className="text-xs text-[var(--color-fg-muted)]">
            Gestión centralizada de perfiles, documentación y preferencias de pasajeros.
          </p>
        </div>
        <button
          onClick={handleOpenAddModal}
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] px-4 py-2.5 text-xs font-bold text-white shadow-md hover:-translate-y-0.5 transition-all duration-200"
        >
          <Plus className="size-4" />
          Registrar Pasajero
        </button>
      </header>

      {/* Stats Cards */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="rounded-xl border border-[var(--color-border)]/40 bg-white p-5 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Total Clientes
            </p>
            <p className="text-2xl font-bold text-[var(--color-fg)] mt-1">{customers.length}</p>
          </div>
          <div className="size-10 rounded-xl bg-blue-50 text-blue-600 flex items-center justify-center">
            <Users className="size-5" />
          </div>
        </div>
        <div className="rounded-xl border border-[var(--color-border)]/40 bg-white p-5 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Con Pasaporte
            </p>
            <p className="text-2xl font-bold text-[var(--color-fg)] mt-1">
              {customers.filter((c) => c.documentType === 'PASAPORTE').length}
            </p>
          </div>
          <div className="size-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <FileText className="size-5" />
          </div>
        </div>
        <div className="rounded-xl border border-[var(--color-border)]/40 bg-white p-5 flex items-center justify-between shadow-sm">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-fg-subtle)]">
              Al día en Preferencias
            </p>
            <p className="text-2xl font-bold text-[var(--color-fg)] mt-1">
              {customers.filter((c) => c.preferences?.meal || c.preferences?.seat).length}
            </p>
          </div>
          <div className="size-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
            <UserCheck className="size-5" />
          </div>
        </div>
      </section>

      {/* Main Board */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: List */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex flex-col sm:flex-row gap-3 items-center justify-between">
            {/* Tab Filters */}
            <div className="flex bg-slate-100 rounded-lg p-1 w-full sm:w-auto">
              <button
                onClick={() => setActiveTab('all')}
                className={`flex-1 sm:flex-initial px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  activeTab === 'all'
                    ? 'bg-white text-[var(--color-fg)] shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Todos
              </button>
              <button
                onClick={() => setActiveTab('passports')}
                className={`flex-1 sm:flex-initial px-4 py-1.5 text-xs font-semibold rounded-md transition-all ${
                  activeTab === 'passports'
                    ? 'bg-white text-[var(--color-fg)] shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Solo Pasaportes
              </button>
            </div>

            {/* Quick Filters */}
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <select
                value={selectedGender}
                onChange={(e) => setSelectedGender(e.target.value)}
                className="bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs font-medium text-slate-700 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)]"
              >
                <option value="ALL">Todos los géneros</option>
                <option value="M">Masculino</option>
                <option value="F">Femenino</option>
                <option value="O">Otro</option>
              </select>
            </div>
          </div>

          {/* Search bar */}
          <div className="relative">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 size-4 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar por nombre, correo, pasaporte, cédula..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white border border-slate-200 pl-10 pr-4 py-3 rounded-xl text-xs placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:border-[var(--color-primary)] shadow-sm"
            />
          </div>

          {/* Customer list container */}
          <div className="bg-white rounded-2xl border border-[var(--color-border)]/45 overflow-hidden shadow-sm">
            {filteredCustomers.length === 0 ? (
              <div className="px-6 py-16 text-center">
                <Compass className="size-8 text-slate-300 mx-auto animate-spin-slow" />
                <p className="text-xs text-slate-400 font-medium mt-3">
                  No se encontraron pasajeros en esta categoría.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {filteredCustomers.map((c) => {
                  const isSelected = selectedCustomer?.id === c.id;
                  const expiryDays = getExpiryDays(c.passportExpiry);

                  return (
                    <div
                      key={c.id}
                      onClick={() => setSelectedCustomer(c)}
                      className={`p-4 flex items-center justify-between cursor-pointer transition-all ${
                        isSelected
                          ? 'bg-slate-50/80 border-l-4 border-[var(--color-primary)]'
                          : 'hover:bg-slate-50/40 border-l-4 border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-3.5 min-w-0">
                        <div className="size-9 rounded-full bg-slate-100 text-slate-600 flex items-center justify-center font-bold text-xs uppercase tracking-tight shrink-0">
                          {c.firstName[0]}
                          {c.lastName[0]}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-xs font-bold text-slate-800 truncate">
                            {c.firstName} {c.lastName}
                          </h3>
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[10px] text-slate-400">
                            <span className="font-semibold text-slate-500 uppercase">
                              {c.documentType}: {c.documentNumber}
                            </span>
                            <span>•</span>
                            <span className="truncate">{c.email ?? 'Sin correo'}</span>
                          </div>
                        </div>
                      </div>

                      {/* Expiry alerts or actions */}
                      <div className="flex items-center gap-3">
                        {c.documentType === 'PASAPORTE' && expiryDays !== null && (
                          <div className="hidden sm:block">
                            {expiryDays < 180 ? (
                              <span className="inline-flex items-center gap-1 bg-red-50 text-red-700 px-2 py-0.5 rounded text-[9px] font-bold">
                                <AlertTriangle className="size-3" />
                                Vence en {expiryDays} días
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 bg-emerald-50 text-emerald-700 px-2 py-0.5 rounded text-[9px] font-bold">
                                <CheckCircle className="size-3" />
                                Vigente
                              </span>
                            )}
                          </div>
                        )}

                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenEditModal(c);
                            }}
                            className="p-1 text-slate-400 hover:text-blue-600 hover:bg-slate-100 rounded-md transition-colors"
                            title="Editar"
                          >
                            <Edit2 className="size-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDelete(c.id);
                            }}
                            className="p-1 text-slate-400 hover:text-red-600 hover:bg-slate-100 rounded-md transition-colors"
                            title="Eliminar"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Passenger details drawer */}
        <div className="lg:col-span-1">
          {selectedCustomer ? (
            <div className="bg-white rounded-2xl border border-[var(--color-border)]/45 overflow-hidden shadow-sm sticky top-8">
              {/* Profile Card Header */}
              <div className="bg-gradient-to-br from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white p-5 text-center relative">
                <div className="size-16 rounded-full bg-white/10 text-white flex items-center justify-center font-bold text-xl uppercase tracking-wider mx-auto shadow-inner border border-white/20">
                  {selectedCustomer.firstName[0]}
                  {selectedCustomer.lastName[0]}
                </div>
                <h2 className="text-sm font-extrabold tracking-tight mt-3">
                  {selectedCustomer.firstName} {selectedCustomer.lastName}
                </h2>
                <span className="inline-block text-[10px] text-slate-300 font-bold bg-white/10 px-2.5 py-0.5 rounded-full mt-1.5 uppercase tracking-wider">
                  Pasajero
                </span>
              </div>

              {/* Profile Details List */}
              <div className="p-5 space-y-5 text-xs">
                {/* Contact info */}
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-1">
                    Datos de Contacto
                  </h4>
                  <div className="flex items-center gap-3 text-slate-600">
                    <Mail className="size-4 text-slate-400 shrink-0" />
                    <span className="truncate">{selectedCustomer.email ?? 'No registrado'}</span>
                  </div>
                  <div className="flex items-center gap-3 text-slate-600">
                    <Phone className="size-4 text-slate-400 shrink-0" />
                    <span>{selectedCustomer.phone ?? 'No registrado'}</span>
                  </div>
                </div>

                {/* Travel Document details */}
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-1">
                    Documento de Viaje
                  </h4>
                  <div className="grid grid-cols-2 gap-3 bg-slate-50 p-3 rounded-xl border border-slate-100">
                    <div>
                      <p className="text-[9px] text-slate-400 font-semibold uppercase">Tipo</p>
                      <p className="font-bold text-slate-800 mt-0.5">
                        {selectedCustomer.documentType}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-400 font-semibold uppercase">Número</p>
                      <p className="font-mono font-bold text-slate-800 mt-0.5">
                        {selectedCustomer.documentNumber}
                      </p>
                    </div>
                    <div>
                      <p className="text-[9px] text-slate-400 font-semibold uppercase">
                        País Emisión
                      </p>
                      <p className="font-bold text-slate-800 mt-0.5">
                        {selectedCustomer.documentIssuingCountry}
                      </p>
                    </div>
                    {selectedCustomer.documentType === 'PASAPORTE' && (
                      <div>
                        <p className="text-[9px] text-slate-400 font-semibold uppercase">Expira</p>
                        <p className="font-bold text-slate-800 mt-0.5">
                          {selectedCustomer.passportExpiry
                            ? new Date(selectedCustomer.passportExpiry).toLocaleDateString('es-CO')
                            : 'N/A'}
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Personal details */}
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-1">
                    Datos Personales
                  </h4>
                  <div className="grid grid-cols-2 gap-2 text-slate-600">
                    <div className="flex justify-between border-b border-slate-50 py-1">
                      <span className="text-slate-400">Nacionalidad:</span>
                      <span className="font-bold text-slate-800">
                        {selectedCustomer.nationality}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-50 py-1">
                      <span className="text-slate-400">Género:</span>
                      <span className="font-bold text-slate-800">
                        {selectedCustomer.gender === 'M'
                          ? 'Masculino'
                          : selectedCustomer.gender === 'F'
                            ? 'Femenino'
                            : 'Otro'}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-slate-50 py-1 col-span-2">
                      <span className="text-slate-400">Fecha Nacimiento:</span>
                      <span className="font-bold text-slate-800">
                        {selectedCustomer.birthdate
                          ? new Date(selectedCustomer.birthdate).toLocaleDateString('es-CO')
                          : 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Travel Preferences */}
                <div className="space-y-3">
                  <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest border-b border-slate-100 pb-1">
                    Preferencias de Vuelo
                  </h4>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div className="bg-slate-50 p-2.5 rounded-lg text-center border border-slate-100">
                      <p className="text-[9px] text-slate-400 uppercase font-semibold">Comida</p>
                      <p className="font-bold text-slate-700 mt-0.5">
                        {selectedCustomer.preferences?.meal ?? 'Ninguna'}
                      </p>
                    </div>
                    <div className="bg-slate-50 p-2.5 rounded-lg text-center border border-slate-100">
                      <p className="text-[9px] text-slate-400 uppercase font-semibold">Asiento</p>
                      <p className="font-bold text-slate-700 mt-0.5">
                        {selectedCustomer.preferences?.seat ?? 'Ninguna'}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-[var(--color-border)]/45 p-8 text-center text-slate-400 shadow-sm">
              <Users className="size-8 text-slate-300 mx-auto" />
              <p className="text-xs font-semibold mt-3">
                Selecciona un pasajero para ver detalles.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 overflow-y-auto">
          <div className="bg-white w-full max-w-2xl rounded-2xl border border-slate-200 overflow-hidden shadow-2xl animate-scale-up my-8">
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-[var(--color-navy)] to-[var(--color-navy-dark)] text-white px-6 py-4 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                  {isEditMode ? 'Editar Perfil' : 'Registro de Pasajero'}
                </h3>
                <h2 className="text-sm font-extrabold mt-0.5 text-white">
                  {isEditMode ? `Pasajero: ${firstName} ${lastName}` : 'Nuevo Pasajero en CRM'}
                </h2>
              </div>
              <button
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Modal Form */}
            <form onSubmit={handleSubmit} className="p-6 space-y-5 text-xs">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Nombres <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Ej: Carlos Andrés"
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Apellidos <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Ej: Mendoza Ortega"
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Correo Electrónico
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="carlos@correo.com"
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Teléfono Celular
                  </label>
                  <input
                    type="text"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+57 300 123 4567"
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Tipo de Documento <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={documentType}
                    onChange={(e) => setDocumentType(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  >
                    <option value="PASAPORTE">Pasaporte</option>
                    <option value="CC">Cédula Ciudadanía</option>
                    <option value="CE">Cédula Extranjería</option>
                    <option value="DNI">DNI / RG</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Número Documento <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    value={documentNumber}
                    onChange={(e) => setDocumentNumber(e.target.value)}
                    placeholder="Ej: AQ123456"
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    País de Emisión
                  </label>
                  <input
                    type="text"
                    value={documentIssuingCountry}
                    onChange={(e) => setDocumentIssuingCountry(e.target.value)}
                    placeholder="COL"
                    maxLength={3}
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Vencimiento Pasaporte
                  </label>
                  <input
                    type="date"
                    value={passportExpiry}
                    disabled={documentType !== 'PASAPORTE'}
                    onChange={(e) => setPassportExpiry(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white disabled:opacity-50"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Nacimiento <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="date"
                    required
                    value={birthdate}
                    onChange={(e) => setBirthdate(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Nacionalidad (ISO-3)
                  </label>
                  <input
                    type="text"
                    value={nationality}
                    onChange={(e) => setNationality(e.target.value)}
                    placeholder="COL"
                    maxLength={3}
                    className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white text-center font-bold"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                    Género
                  </label>
                  <div className="flex bg-slate-50 border border-slate-200 rounded-xl mt-1.5 p-1">
                    <button
                      type="button"
                      onClick={() => setGender('M')}
                      className={`flex-1 py-1.5 rounded-lg font-bold text-center ${
                        gender === 'M' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'
                      }`}
                    >
                      M
                    </button>
                    <button
                      type="button"
                      onClick={() => setGender('F')}
                      className={`flex-1 py-1.5 rounded-lg font-bold text-center ${
                        gender === 'F' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'
                      }`}
                    >
                      F
                    </button>
                    <button
                      type="button"
                      onClick={() => setGender('O')}
                      className={`flex-1 py-1.5 rounded-lg font-bold text-center ${
                        gender === 'O' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-400'
                      }`}
                    >
                      Otro
                    </button>
                  </div>
                </div>
              </div>

              {/* Preferences details */}
              <div className="space-y-3 pt-3 border-t border-slate-100">
                <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                  Preferencias del Pasajero (Opcionales)
                </h4>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Comida Preferida (Ej: Vegana, Gluten Free)
                    </label>
                    <input
                      type="text"
                      value={mealPref}
                      onChange={(e) => setMealPref(e.target.value)}
                      placeholder="Ej: VGML"
                      className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                      Asiento Preferido (Ej: Ventana, Pasillo)
                    </label>
                    <input
                      type="text"
                      value={seatPref}
                      onChange={(e) => setSeatPref(e.target.value)}
                      placeholder="Ej: Pasillo"
                      className="w-full bg-slate-50 border border-slate-200 px-3 py-2.5 rounded-xl text-xs mt-1.5 focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] focus:bg-white"
                    />
                  </div>
                </div>
              </div>

              {/* Action buttons */}
              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-4 py-2.5 border border-slate-200 text-slate-500 font-bold hover:bg-slate-50 rounded-xl"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-5 py-2.5 bg-gradient-to-r from-[var(--color-primary)] to-[var(--color-accent)] text-white font-bold shadow-md hover:-translate-y-0.5 rounded-xl transition"
                >
                  {isEditMode ? 'Guardar Cambios' : 'Registrar Pasajero'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
