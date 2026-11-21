import { defineKind } from '@editor-platform/artifact-kinds';
import { createSchedule, isSchedule, type ScheduleDocument } from './model';

/** The Schedule kind. A new schedule takes the Host's time zone. */
export const scheduleKind = (timeZone: () => string) =>
  defineKind<ScheduleDocument>({
    kind: 'schedule',
    area: 'office',
    label: 'Schedule',
    icon: '◷',
    description: 'Plan events next to the work they belong to',
    creatable: true,
    create: (count) => ({ name: `Schedule ${count}`, content: createSchedule(timeZone()) }),
    validate: isSchedule,
  });
