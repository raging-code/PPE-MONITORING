// GET /api/events (design 3.8): the rows of v_events after a sequence number, in event_seq order. Never a frame row, no raw_hex.
import { request, type ActionResult, type Api } from './actions.ts';

export interface LogRow { event_seq: number; log_ts: number; record_type: 'alert_raised' | 'alert_cleared' | 'audit' | 'system' | 'advisory'; node_id: number | null; level: string | null; code: string; detail: string | null; operator_id: number | null }
export interface EventsBody { events: LogRow[]; last_seq: number }
export const getEvents = (api: Api, afterSeq: number, limit: number): Promise<ActionResult<EventsBody>> => request<EventsBody>(api, 'GET', `/api/events?after_seq=${afterSeq}&limit=${limit}`);
