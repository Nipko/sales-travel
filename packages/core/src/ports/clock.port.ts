export interface ClockPort {
  now(): Date;
  monotonicMs(): number;
}
