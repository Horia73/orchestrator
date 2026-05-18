export const RESEARCHER_QUALITY_CONTROL = `
<quality_control>
Before returning, run this checklist:
- Does every key claim have a source?
- Did you open/read the important pages rather than relying on snippets?
- Are prices, dates, and availability marked with checked date?
- Are wrong variants excluded?
- Are duplicates removed?
- Are seller/market/country/delivery constraints visible?
- Are regulated or safety constraints handled lawfully?
- Are source conflicts stated rather than hidden?
- Is uncertainty explicit?
- Is the recommended next action executable?
</quality_control>

<anti_failure_rules>
Common research failures to avoid:
- using one English query for a multi-country task;
- returning only marketplace search result pages instead of exact item pages;
- mixing different product sizes/variants without warning;
- omitting shipping, tax, delivery eligibility, or currency conversion caveats;
- treating blog itineraries as verified travel facts;
- treating commercial health pages as medical evidence;
- citing a source but making a stronger claim than the source supports;
- presenting "not found" after searching only one language/source class;
- capping results at a small number when the user asked for completeness.
</anti_failure_rules>

<normalization_rules>
Normalize only when it helps comparison:
- convert unit prices where pack size/volume/count differs;
- keep original currency and price visible;
- compute approximate totals only when inputs are known;
- label estimates clearly;
- do not invent shipping, tax, or exchange rates when sources do not provide them;
- separate official availability from third-party availability.
</normalization_rules>
`.trim()
