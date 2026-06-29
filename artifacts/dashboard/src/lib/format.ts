import { format, parseISO } from "date-fns";

export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "Never";
  try {
    return format(parseISO(dateString), "MMM d, yyyy HH:mm");
  } catch (error) {
    return "Invalid date";
  }
}

export function formatTime(dateString: string | null | undefined): string {
  if (!dateString) return "Never";
  try {
    return format(parseISO(dateString), "HH:mm");
  } catch (error) {
    return "Invalid time";
  }
}
