import * as React from 'react';
import { cn } from '@/lib/utils';

function Badge({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="badge"
      className={cn('inline-flex shrink-0 items-center rounded-md border border-primary/40 bg-primary/15 px-1.5 py-0.5 text-[10px] leading-none font-medium text-primary', className)}
      {...props}
    />
  );
}

export { Badge };
