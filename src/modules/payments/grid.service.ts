export const DAYS_MAP: Record<string, number> = {
  DOMINGO: 0,
  LUNES: 1,
  MARTES: 2,
  MIERCOLES: 3,
  MIÉRCOLES: 3,
  JUEVES: 4,
  VIERNES: 5,
  SABADO: 6,
  SÁBADO: 6,
};

export const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

export class PaymentGridService {
  /**
   * Calcula la fecha óptima en la grilla semanal de pagos en base a la fecha de vencimiento
   * y los días configurados por la empresa (ej: Martes y Jueves).
   */
  calculateScheduledDate(dueDate: Date, configuredDaysStr: string): Date {
    const configuredDayNumbers = configuredDaysStr
      .split(',')
      .map((d) => d.trim().toUpperCase())
      .map((d) => DAYS_MAP[d])
      .filter((n): n is number => n !== undefined && !isNaN(n));

    // Si no tiene días configurados, se paga el mismo día de vencimiento
    if (configuredDayNumbers.length === 0) {
      return new Date(dueDate);
    }

    const dueDay = dueDate.getDay();

    // Si el día de vencimiento coincide con un día de pago, se asigna ese mismo día
    if (configuredDayNumbers.includes(dueDay)) {
      return new Date(dueDate);
    }

    // Buscamos el día de pago anterior más cercano dentro de la misma semana o semana previa
    // para evitar entrar en mora, o el día hábil configurado más cercano.
    let targetDate = new Date(dueDate);
    for (let diff = 1; diff <= 7; diff++) {
      // Priorizamos pagar en el corte previo inmediato
      const candidateBefore = new Date(dueDate);
      candidateBefore.setDate(dueDate.getDate() - diff);
      if (configuredDayNumbers.includes(candidateBefore.getDay())) {
        return candidateBefore;
      }
    }

    return new Date(dueDate);
  }

  /**
   * Formatea una fecha de manera amigable para WhatsApp: "Jueves 10/09/2026"
   */
  formatFriendlyDate(date: Date): string {
    const dayName = DAY_NAMES[date.getDay()];
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dayName} ${dd}/${mm}/${yyyy}`;
  }

  /**
   * Mueve una fecha a la siguiente fecha disponible en la grilla
   */
  postponeToNextGridDate(currentDate: Date, configuredDaysStr: string, daysAhead = 7): Date {
    const newDate = new Date(currentDate);
    newDate.setDate(newDate.getDate() + daysAhead);
    return this.calculateScheduledDate(newDate, configuredDaysStr);
  }
}

export const paymentGridService = new PaymentGridService();
