
import os

file_path = '/Users/banhdaidung/Downloads/stitch_website_qu_n_l_n_h_ng_nguy_n_li_u/thiet_ke_web_hoan_chinh/Nevo-task/index.html'

with open(file_path, 'r', encoding='utf-8') as f:
    lines = f.readlines()

new_lines = []
skip = False

# Update thead headers
for i in range(len(lines)):
    line = lines[i]
    if '<th id="finCategoryHeaderEnd" class="hidden"></th>' in line:
        new_lines.append(line)
        new_lines.append('                                         <th class="py-5 px-6 text-right w-32 border-l border-slate-100 bg-slate-100/50">Tổng chi</th>\n')
        new_lines.append('                                         <th class="py-5 px-6 text-center w-24 border-l border-slate-100">Xóa</th>\n')
    elif 'Mã dòng tiền:' in line and 'colspan="5"' in line:
        new_lines.append(line)
        # Search for next </tr>
        j = i + 1
        while j < len(lines) and '</tr>' not in lines[j]:
            j += 1
        # Insert before </tr>
        # Actually replace the whole <tr> block for summary rows
        pass
    else:
        new_lines.append(line)

# Let's do a more robust string replacement for the summary rows block
content = "".join(new_lines)

# Target block for summary rows
target_summary = """                                     <tr class="bg-white text-[9px] font-bold text-blue-500 uppercase border-b border-slate-50">
                                         <td colspan="5" class="py-2 px-6 text-right font-black italic opacity-50 sticky left-0 bg-white z-10">Mã dòng tiền:</td>
                                     </tr>
                                     <tr class="bg-orange-500 text-white text-[10px] font-black uppercase">
                                         <td colspan="5" class="py-3 px-6 text-right tracking-widest sticky left-0 bg-orange-500 z-10">PLAN THÁNG:</td>
                                     </tr>
                                     <tr class="bg-yellow-400 text-[#131b2e] text-[10px] font-black uppercase">
                                         <td colspan="5" class="py-3 px-6 text-right tracking-widest sticky left-0 bg-yellow-400 z-10">CÒN LẠI:</td>
                                     </tr>"""

replacement_summary = """                                     <tr class="bg-white text-[9px] font-bold text-blue-500 uppercase border-b border-slate-50">
                                         <td colspan="5" class="py-2 px-6 text-right font-black italic opacity-50 sticky left-0 bg-white z-10">Mã dòng tiền:</td>
                                         <td id="finTableTotalCode" class="py-2 px-6 text-right border-l border-slate-50 font-black"></td>
                                         <td class="bg-slate-50"></td>
                                     </tr>
                                     <tr class="bg-orange-500 text-white text-[10px] font-black uppercase">
                                         <td colspan="5" class="py-3 px-6 text-right tracking-widest sticky left-0 bg-orange-500 z-10">PLAN THÁNG:</td>
                                         <td id="finTableTotalPlan" class="py-3 px-6 text-right border-l border-orange-400 font-black"></td>
                                         <td class="bg-orange-600"></td>
                                     </tr>
                                     <tr class="bg-yellow-400 text-[#131b2e] text-[10px] font-black uppercase">
                                         <td colspan="5" class="py-3 px-6 text-right tracking-widest sticky left-0 bg-yellow-400 z-10">CÒN LẠI:</td>
                                         <td id="finTableTotalRemain" class="py-3 px-6 text-right border-l border-yellow-500 font-black"></td>
                                         <td class="bg-yellow-500"></td>
                                     </tr>"""

if target_summary in content:
    content = content.replace(target_summary, replacement_summary)
else:
    print("Target summary block not found exactly. Trying with less whitespace sensitivity.")
    # Fallback to lines search if needed

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)
