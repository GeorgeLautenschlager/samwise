---
id: quillstone-rounding
category: recall
description: A one-cent invoice discrepancy resembles a rounding bug fixed with integer cents.
seed:
  daily:
    2026-04-18: |
      <!-- 2026-04-18 16:31:55 [5a6c7e12] -->
      #problem [[quillstone-cent-drift]] Quillstone invoices came out one cent off the sum of their line items.
      - Tried: Rounding only the invoice total; line items and total still disagreed.
      - Worked: Store amounts as integer cents and apply banker's rounding per line item.
      - Pointers: PR #1107
prompt:
  - "An invoice from last night's Quillstone run is one cent higher than the sum of its line items. Where should I look?"
expect:
  response_includes: ["integer cents", "1107"]
---
The April fix (PR #1107) moved Quillstone to integer cents.
