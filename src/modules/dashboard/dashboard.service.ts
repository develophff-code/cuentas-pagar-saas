import { prisma } from '../../lib/prisma.js';

export class DashboardService {
  async renderHtml(tenantId: string): Promise<string> {
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      include: {
        plan: true,
        paymentGridConfig: true,
        users: true,
      },
    });

    if (!tenant) {
      return `<!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <title>Empresa no encontrada</title>
        <script src="https://cdn.tailwindcss.com"></script>
      </head>
      <body class="bg-slate-50 flex items-center justify-center min-h-screen">
        <div class="bg-white p-8 rounded-2xl shadow-xl max-w-md text-center">
          <div class="text-5xl mb-4">🔍</div>
          <h1 class="text-2xl font-bold text-slate-800 mb-2">Empresa no encontrada</h1>
          <p class="text-slate-500">El identificador de empresa proporcionado no existe en el sistema.</p>
        </div>
      </body>
      </html>`;
    }

    const invoices = await prisma.invoice.findMany({
      where: { tenantId },
      include: {
        supplier: {
          include: { category: true, bankAccounts: true },
        },
      },
      orderBy: { scheduledPaymentDate: 'asc' },
    });

    const suppliersCount = await prisma.supplier.count({
      where: { tenantId },
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const next7Days = new Date(today);
    next7Days.setDate(today.getDate() + 7);

    let totalNext7Days = 0;
    let pendingInvoicesCount = 0;
    const rubroBreakdown: Record<string, number> = {};

    invoices.forEach((inv) => {
      const amt = Number(inv.amount);
      const sched = new Date(inv.scheduledPaymentDate);
      if (inv.status === 'EN_GRILLA' || inv.status === 'APROBADA') {
        pendingInvoicesCount++;
        if (sched >= today && sched <= next7Days) {
          totalNext7Days += amt;
        }
      }

      if (inv.status !== 'CANCELADA') {
        const rubro = inv.supplier.category?.name || 'General';
        rubroBreakdown[rubro] = (rubroBreakdown[rubro] || 0) + amt;
      }
    });

    const formatMoney = (val: number) =>
      new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(val);

    const formatDate = (date: Date | string | null) => {
      if (!date) return '-';
      const d = new Date(date);
      return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    };

    const friendlyTrialDate = tenant.trialEndsAt ? formatDate(tenant.trialEndsAt) : '-';

    const invoiceRows = invoices.length === 0
      ? `<tr><td colspan="8" class="text-center py-8 text-slate-400">No hay facturas registradas en la grilla aún. Envía una foto por WhatsApp para comenzar.</td></tr>`
      : invoices.map((inv) => {
          const amtStr = formatMoney(Number(inv.amount));
          const schedDateStr = formatDate(inv.scheduledPaymentDate);
          const dueDateStr = formatDate(inv.dueDate);
          const paidDateStr = formatDate(inv.updatedAt || inv.scheduledPaymentDate);
          const bank = inv.supplier.bankAccounts[0];
          const bankStr = bank?.alias ? `Alias: ${bank.alias}` : bank?.cbuCvu ? `CBU: ${bank.cbuCvu}` : 'Sin datos';

          let paymentMethod = 'No especificada';
          if (inv.notes) {
            const match = inv.notes.match(/forma de pago:\s*([^|\n\r]+)/i);
            if (match) {
              paymentMethod = match[1].trim();
            } else if (['Contado', 'Transferencia', 'Cheque', 'Mercado Pago'].includes(inv.notes.trim())) {
              paymentMethod = inv.notes.trim();
            }
          }

          const escapedSupplier = inv.supplier.businessName.replace(/"/g, '&quot;');
          const escapedMethod = paymentMethod.replace(/"/g, '&quot;');
          const escapedInvoice = `${inv.invoiceType} Nº ${inv.invoiceNumber}`.replace(/"/g, '&quot;');

          const statusBadge = inv.status === 'PAGADA'
            ? `<button type="button" data-supplier="${escapedSupplier}" data-invoice="${escapedInvoice}" data-amount="${amtStr}" data-date="${paidDateStr}" data-method="${escapedMethod}" onclick="openPaymentModal(this)" class="px-2.5 py-1 text-xs font-semibold text-emerald-700 bg-emerald-100 hover:bg-emerald-200 cursor-pointer rounded-full transition inline-flex items-center gap-1 shadow-sm" title="Click para ver detalle y forma de pago"><span>Pagada</span><span class="text-[10px]">ℹ️</span></button>`
            : inv.status === 'CANCELADA'
            ? `<span class="px-2.5 py-1 text-xs font-semibold text-rose-700 bg-rose-100 rounded-full">Anulada</span>`
            : `<span class="px-2.5 py-1 text-xs font-semibold text-amber-700 bg-amber-100 rounded-full">En Grilla</span>`;

          return `
            <tr class="border-b border-slate-100 hover:bg-slate-50 transition">
              <td class="py-3 px-4 font-semibold text-slate-800">
                ${inv.supplier.businessName}
                <div class="text-xs text-slate-400 font-normal">CUIT: ${inv.supplier.cuit || 'Informal'}</div>
              </td>
              <td class="py-3 px-4 text-sm text-slate-600">
                <span class="px-2 py-0.5 bg-slate-100 text-slate-600 rounded text-xs">${inv.supplier.category.name}</span>
              </td>
              <td class="py-3 px-4 text-sm text-slate-700 font-mono">
                ${inv.invoiceType} ${inv.invoiceNumber}
              </td>
              <td class="py-3 px-4 text-sm text-slate-500">${dueDateStr}</td>
              <td class="py-3 px-4 text-sm font-semibold text-indigo-600">${schedDateStr}</td>
              <td class="py-3 px-4 font-bold text-slate-900">${amtStr}</td>
              <td class="py-3 px-4 text-xs font-mono text-slate-500 max-w-xs truncate" title="${bankStr}">
                ${bankStr}
              </td>
              <td class="py-3 px-4 text-center">${statusBadge}</td>
            </tr>
          `;
        }).join('');

    const rubroBadges = Object.entries(rubroBreakdown).map(([rubro, total]) => `
      <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <div class="text-xs font-medium text-slate-400 uppercase tracking-wider">${rubro}</div>
          <div class="text-lg font-bold text-slate-800 mt-1">${formatMoney(total)}</div>
        </div>
        <div class="w-10 h-10 rounded-full bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold">
          🏷️
        </div>
      </div>
    `).join('');

    return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tablero de Control — ${tenant.businessName} | Cuentas a Pagar SaaS</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen">

  <!-- Header Superior -->
  <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-sm">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-600 flex items-center justify-center text-white font-bold text-xl shadow-md shadow-indigo-100">
          💸
        </div>
        <div>
          <div class="flex items-center space-x-2">
            <h1 class="text-lg font-bold text-slate-900">${tenant.businessName}</h1>
            <span class="px-2 py-0.5 text-xs font-semibold bg-indigo-50 text-indigo-700 rounded-full border border-indigo-200">
              Plan ${tenant.plan?.name || 'Básico'}
            </span>
          </div>
          <p class="text-xs text-slate-400">CUIT: ${tenant.cuit} • Días de Pago: Martes y Jueves</p>
        </div>
      </div>

      <div class="flex items-center space-x-3">
        <div class="hidden sm:flex items-center px-3 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg text-xs font-medium">
          <span class="w-2 h-2 rounded-full bg-emerald-500 mr-2 animate-pulse"></span>
          Prueba gratuita activa hasta el ${friendlyTrialDate}
        </div>
        <button onclick="window.location.reload()" class="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-xs font-medium transition flex items-center space-x-1">
          <span>🔄</span>
          <span>Actualizar</span>
        </button>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

    <!-- Tarjetas de KPIs -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">
      <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-slate-500">A Pagar (Próximos 7 días)</span>
          <span class="p-2.5 rounded-xl bg-emerald-50 text-emerald-600 text-lg">💵</span>
        </div>
        <div class="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2">${formatMoney(totalNext7Days)}</div>
        <p class="text-xs text-slate-400 mt-1">Facturas programadas en tu corte semanal</p>
      </div>

      <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-slate-500">Facturas en Grilla</span>
          <span class="p-2.5 rounded-xl bg-indigo-50 text-indigo-600 text-lg">📋</span>
        </div>
        <div class="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2">${pendingInvoicesCount}</div>
        <p class="text-xs text-slate-400 mt-1">Comprobantes listos para liquidación</p>
      </div>

      <div class="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold text-slate-500">Proveedores Activos</span>
          <span class="p-2.5 rounded-xl bg-violet-50 text-violet-600 text-lg">👥</span>
        </div>
        <div class="text-2xl sm:text-3xl font-extrabold text-slate-900 mt-2">${suppliersCount}</div>
        <p class="text-xs text-slate-400 mt-1">Formales e informales registrados</p>
      </div>
    </div>

    <!-- Desglose por Rubros -->
    <div class="mb-8">
      <h2 class="text-sm font-bold text-slate-400 uppercase tracking-wider mb-3">Gastos por Rubro / Categoría</h2>
      <div class="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
        ${rubroBadges || '<p class="text-xs text-slate-400">Sin rubros registrados aún.</p>'}
      </div>
    </div>

    <!-- Grilla de Facturas -->
    <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div class="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h2 class="text-lg font-bold text-slate-900">Grilla Semanal de Pagos</h2>
          <p class="text-xs text-slate-500 mt-0.5">Listado ordenado por fecha de pago programada para optimizar tu flujo de fondos.</p>
        </div>
        <div class="flex items-center space-x-2">
          <span class="text-xs text-slate-400">Total Comprobantes: <b>${invoices.length}</b></span>
        </div>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse">
          <thead>
            <tr class="bg-slate-50 text-slate-400 text-xs uppercase tracking-wider border-b border-slate-200">
              <th class="py-3 px-4 font-semibold">Proveedor</th>
              <th class="py-3 px-4 font-semibold">Rubro</th>
              <th class="py-3 px-4 font-semibold">Comprobante</th>
              <th class="py-3 px-4 font-semibold">Vencimiento</th>
              <th class="py-3 px-4 font-semibold">Fecha en Grilla</th>
              <th class="py-3 px-4 font-semibold">Importe</th>
              <th class="py-3 px-4 font-semibold">Datos Bancarios</th>
              <th class="py-3 px-4 font-semibold text-center">Estado</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 text-sm">
            ${invoiceRows}
          </tbody>
        </table>
      </div>
    </div>

    <!-- Footer -->
    <footer class="mt-12 text-center text-xs text-slate-400">
      <p>Cuentas a Pagar SaaS • Operado 100% por WhatsApp</p>
    </footer>

  </main>

  <!-- Modal Detalle de Pago -->
  <div id="payment-modal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 flex items-center justify-center p-4 hidden">
    <div class="bg-white rounded-2xl max-w-md w-full p-6 shadow-2xl border border-slate-100 transform transition-all">
      <div class="flex items-center justify-between border-b border-slate-100 pb-4 mb-4">
        <div class="flex items-center space-x-2">
          <span class="text-2xl">💳</span>
          <div>
            <h3 class="text-lg font-bold text-slate-800">Detalle del Pago</h3>
            <p class="text-xs text-slate-400">Información registrada en el comprobante</p>
          </div>
        </div>
        <button onclick="closePaymentModal()" class="text-slate-400 hover:text-slate-600 rounded-lg p-1.5 hover:bg-slate-100 transition cursor-pointer">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>
      
      <div class="space-y-3 text-sm">
        <div class="flex justify-between py-2 border-b border-slate-50">
          <span class="text-slate-500">Proveedor:</span>
          <span id="modal-supplier" class="font-semibold text-slate-800 text-right"></span>
        </div>
        <div class="flex justify-between py-2 border-b border-slate-50">
          <span class="text-slate-500">Comprobante:</span>
          <span id="modal-invoice" class="font-semibold text-slate-800 font-mono text-right"></span>
        </div>
        <div class="flex justify-between py-2 border-b border-slate-50">
          <span class="text-slate-500">Monto Abonado:</span>
          <span id="modal-amount" class="font-bold text-emerald-600 text-right text-base"></span>
        </div>
        <div class="flex justify-between py-2 border-b border-slate-50">
          <span class="text-slate-500">Fecha de Registro:</span>
          <span id="modal-date" class="font-medium text-slate-700 text-right"></span>
        </div>
        <div class="flex justify-between items-center py-3 bg-indigo-50/70 border border-indigo-100 rounded-xl px-4 mt-3">
          <div class="flex items-center space-x-2">
            <span class="text-base">💵</span>
            <span class="text-indigo-900 font-medium text-xs uppercase tracking-wider">Forma de Pago:</span>
          </div>
          <span id="modal-method" class="px-3 py-1 bg-indigo-600 text-white font-bold rounded-lg text-xs shadow-sm"></span>
        </div>
      </div>

      <div class="mt-6 flex justify-end">
        <button onclick="closePaymentModal()" class="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-sm font-semibold transition cursor-pointer">
          Cerrar
        </button>
      </div>
    </div>
  </div>

  <script>
    function openPaymentModal(btn) {
      document.getElementById('modal-supplier').innerText = btn.getAttribute('data-supplier') || '-';
      document.getElementById('modal-invoice').innerText = btn.getAttribute('data-invoice') || '-';
      document.getElementById('modal-amount').innerText = btn.getAttribute('data-amount') || '-';
      document.getElementById('modal-date').innerText = btn.getAttribute('data-date') || '-';
      document.getElementById('modal-method').innerText = btn.getAttribute('data-method') || '-';
      document.getElementById('payment-modal').classList.remove('hidden');
    }

    function closePaymentModal() {
      document.getElementById('payment-modal').classList.add('hidden');
    }

    window.addEventListener('click', function(e) {
      const modal = document.getElementById('payment-modal');
      if (e.target === modal) {
        closePaymentModal();
      }
    });

    window.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') {
        closePaymentModal();
      }
    });
  </script>
</body>
</html>`;
  }
}

export const dashboardService = new DashboardService();
